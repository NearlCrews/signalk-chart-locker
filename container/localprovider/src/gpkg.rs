//! Pure-Rust decoder for the GeoPackage geometry BLOB (StandardGeoPackageBinary)
//! and the ISO/OGC WKB it wraps. No libgdal, mod_spatialite, libgeos, or libproj:
//! everything here is byte parsing over `&[u8]`.
//!
//! Byte layout decoded (per the OGC GeoPackage 1.3 spec):
//!
//! GP header:
//!   byte 0..1  magic   = 0x47 0x50 ("GP")
//!   byte 2     version = 0x00
//!   byte 3     flags: bit0 header byte order (0 big, 1 little), bits1..3 envelope
//!              indicator (0 none, 1 XY, 2 XYZ, 3 XYM, 4 XYZM), bit4 empty,
//!              bit5 0 for StandardGeoPackageBinary
//!   byte 4..7  srs_id  int32 in header byte order
//!   [envelope] 0, 32, 48, or 64 bytes of doubles per indicator
//!   [wkb]      standard WKB follows immediately
//!
//! WKB:
//!   byte 0     byte order (1 little, 0 big)
//!   uint32     geometry type (3 Polygon, 6 MultiPolygon)
//!   Polygon:      uint32 numRings; per ring uint32 numPoints; numPoints*(f64 x, f64 y)
//!   MultiPolygon: uint32 numPolys; per poly (byte order, uint32 type=3, Polygon body)

use std::fmt;

/// A decoded vertex as `[lon, lat]` (WKB `x`, `y`).
pub type Point = [f64; 2];

const WKB_POLYGON: u32 = 3;
const WKB_MULTIPOLYGON: u32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryKind {
    Empty,
    Polygon,
    MultiPolygon,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Polygon {
    /// Exterior ring first, then any interior rings (holes).
    pub rings: Vec<Vec<Point>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Geometry {
    pub srs_id: i32,
    pub kind: GeometryKind,
    pub polygons: Vec<Polygon>,
}

impl Geometry {
    /// Human-readable geometry kind: "Polygon", "MultiPolygon", or "Empty".
    pub fn geom_type_name(&self) -> &'static str {
        match self.kind {
            GeometryKind::Empty => "Empty",
            GeometryKind::Polygon => "Polygon",
            GeometryKind::MultiPolygon => "MultiPolygon",
        }
    }

    pub fn vertex_count(&self) -> usize {
        self.polygons
            .iter()
            .flat_map(|p| p.rings.iter())
            .map(|r| r.len())
            .sum()
    }

    pub fn ring_count(&self) -> usize {
        self.polygons.iter().map(|p| p.rings.len()).sum()
    }

    /// The first polygon's exterior ring, if any.
    pub fn first_ring(&self) -> Option<&Vec<Point>> {
        self.polygons.first().and_then(|p| p.rings.first())
    }

    /// Bounding box `[minx, miny, maxx, maxy]` over every decoded vertex.
    pub fn bounds(&self) -> Option<[f64; 4]> {
        bounds_of(
            self.polygons
                .iter()
                .flat_map(|p| p.rings.iter())
                .flat_map(|r| r.iter()),
        )
    }

    /// Bounding box over just the first polygon's exterior ring.
    pub fn first_ring_bounds(&self) -> Option<[f64; 4]> {
        bounds_of(self.first_ring()?.iter())
    }
}

/// Bounding box `[minx, miny, maxx, maxy]` over a stream of points, or None if empty.
fn bounds_of<'a>(points: impl Iterator<Item = &'a Point>) -> Option<[f64; 4]> {
    let mut points = points;
    let first = points.next()?;
    let mut b = [first[0], first[1], first[0], first[1]];
    for p in points {
        if p[0] < b[0] {
            b[0] = p[0];
        }
        if p[1] < b[1] {
            b[1] = p[1];
        }
        if p[0] > b[2] {
            b[2] = p[0];
        }
        if p[1] > b[3] {
            b[3] = p[1];
        }
    }
    Some(b)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GpkgError {
    /// Buffer ended before a field could be read in full.
    TooShort,
    /// First two bytes were not the "GP" magic.
    BadMagic([u8; 2]),
    /// Header flag bit5 set: ExtendedGeoPackageBinary, not handled by this spike.
    ExtendedGeometry,
    /// Envelope indicator was outside 0..=4.
    BadEnvelopeIndicator(u8),
    /// WKB byte order byte was neither 0 nor 1.
    BadByteOrder(u8),
    /// WKB geometry type was something other than Polygon or MultiPolygon.
    UnsupportedWkbType(u32),
}

impl fmt::Display for GpkgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GpkgError::TooShort => write!(f, "geometry blob ended early"),
            GpkgError::BadMagic(m) => {
                write!(f, "bad GeoPackage magic: {:#04x} {:#04x}", m[0], m[1])
            }
            GpkgError::ExtendedGeometry => {
                write!(f, "ExtendedGeoPackageBinary geometry is not supported")
            }
            GpkgError::BadEnvelopeIndicator(i) => write!(f, "bad envelope indicator: {i}"),
            GpkgError::BadByteOrder(b) => write!(f, "bad WKB byte order byte: {b}"),
            GpkgError::UnsupportedWkbType(t) => {
                write!(f, "unsupported WKB geometry type: {t}")
            }
        }
    }
}

impl std::error::Error for GpkgError {}

/// Decode a GeoPackage geometry BLOB into polygon rings.
pub fn decode(blob: &[u8]) -> Result<Geometry, GpkgError> {
    if blob.len() < 8 {
        return Err(GpkgError::TooShort);
    }
    if blob[0] != 0x47 || blob[1] != 0x50 {
        return Err(GpkgError::BadMagic([blob[0], blob[1]]));
    }
    // blob[2] is the version; the spec only defines 0 today and we do not branch on it.
    let flags = blob[3];
    let header_le = (flags & 0x01) != 0;
    let envelope_indicator = (flags >> 1) & 0x07;
    let empty = (flags & 0x10) != 0;
    let extended = (flags & 0x20) != 0;
    if extended {
        return Err(GpkgError::ExtendedGeometry);
    }

    let mut r = Reader::new(blob);
    r.skip(4)?; // magic, version, flags
    let srs_id = r.read_i32(header_le)?;
    r.skip(envelope_len(envelope_indicator)?)?;

    if empty {
        return Ok(Geometry {
            srs_id,
            kind: GeometryKind::Empty,
            polygons: Vec::new(),
        });
    }

    let (kind, polygons) = read_wkb(&mut r)?;
    Ok(Geometry {
        srs_id,
        kind,
        polygons,
    })
}

/// Envelope byte length for an indicator: 0 none, 1 XY, 2 XYZ, 3 XYM, 4 XYZM.
fn envelope_len(indicator: u8) -> Result<usize, GpkgError> {
    match indicator {
        0 => Ok(0),
        1 => Ok(32),
        2 | 3 => Ok(48),
        4 => Ok(64),
        other => Err(GpkgError::BadEnvelopeIndicator(other)),
    }
}

fn read_wkb(r: &mut Reader) -> Result<(GeometryKind, Vec<Polygon>), GpkgError> {
    let le = read_byte_order(r)?;
    let geom_type = r.read_u32(le)?;
    match geom_type {
        WKB_POLYGON => {
            let poly = read_polygon_body(r, le)?;
            Ok((GeometryKind::Polygon, vec![poly]))
        }
        WKB_MULTIPOLYGON => {
            let count = r.read_u32(le)?;
            r.ensure(count as usize * 9)?; // each part is at least a 9-byte header
            let mut polys = Vec::with_capacity(count as usize);
            for _ in 0..count {
                // Each part carries its own byte order and type tag.
                let part_le = read_byte_order(r)?;
                let part_type = r.read_u32(part_le)?;
                if part_type != WKB_POLYGON {
                    return Err(GpkgError::UnsupportedWkbType(part_type));
                }
                polys.push(read_polygon_body(r, part_le)?);
            }
            Ok((GeometryKind::MultiPolygon, polys))
        }
        other => Err(GpkgError::UnsupportedWkbType(other)),
    }
}

fn read_polygon_body(r: &mut Reader, le: bool) -> Result<Polygon, GpkgError> {
    let num_rings = r.read_u32(le)?;
    r.ensure(num_rings as usize * 4)?; // every ring header is a 4-byte count
    let mut rings = Vec::with_capacity(num_rings as usize);
    for _ in 0..num_rings {
        let num_points = r.read_u32(le)?;
        r.ensure(num_points as usize * 16)?; // 2 doubles per point
        let mut ring = Vec::with_capacity(num_points as usize);
        for _ in 0..num_points {
            let x = r.read_f64(le)?;
            let y = r.read_f64(le)?;
            ring.push([x, y]);
        }
        rings.push(ring);
    }
    Ok(Polygon { rings })
}

fn read_byte_order(r: &mut Reader) -> Result<bool, GpkgError> {
    match r.read_u8()? {
        1 => Ok(true),
        0 => Ok(false),
        other => Err(GpkgError::BadByteOrder(other)),
    }
}

/// A bounds-checked cursor over the geometry blob. Counts read from the blob are
/// validated against the bytes that remain before any allocation, so a corrupt
/// length field cannot trigger a huge `Vec` reservation.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    /// Fail early if fewer than `n` bytes remain (used before sizing a `Vec`).
    fn ensure(&self, n: usize) -> Result<(), GpkgError> {
        if self.remaining() < n {
            Err(GpkgError::TooShort)
        } else {
            Ok(())
        }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], GpkgError> {
        let end = self.pos.checked_add(n).ok_or(GpkgError::TooShort)?;
        let slice = self.buf.get(self.pos..end).ok_or(GpkgError::TooShort)?;
        self.pos = end;
        Ok(slice)
    }

    fn skip(&mut self, n: usize) -> Result<(), GpkgError> {
        self.take(n).map(|_| ())
    }

    fn read_u8(&mut self) -> Result<u8, GpkgError> {
        Ok(self.take(1)?[0])
    }

    fn read_u32(&mut self, le: bool) -> Result<u32, GpkgError> {
        let bytes: [u8; 4] = self.take(4)?.try_into().expect("take(4) yields 4 bytes");
        Ok(if le {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    }

    fn read_i32(&mut self, le: bool) -> Result<i32, GpkgError> {
        let bytes: [u8; 4] = self.take(4)?.try_into().expect("take(4) yields 4 bytes");
        Ok(if le {
            i32::from_le_bytes(bytes)
        } else {
            i32::from_be_bytes(bytes)
        })
    }

    fn read_f64(&mut self, le: bool) -> Result<f64, GpkgError> {
        let bytes: [u8; 8] = self.take(8)?.try_into().expect("take(8) yields 8 bytes");
        Ok(if le {
            f64::from_le_bytes(bytes)
        } else {
            f64::from_be_bytes(bytes)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a GP header in front of a WKB body. `env_indicator` controls how many
    /// zeroed envelope bytes are inserted so the decoder's skip logic is exercised.
    fn gp_blob(header_le: bool, env_indicator: u8, srs_id: i32, wkb: &[u8]) -> Vec<u8> {
        let mut v = vec![0x47, 0x50, 0x00];
        let mut flags = 0u8;
        if header_le {
            flags |= 0x01;
        }
        flags |= (env_indicator & 0x07) << 1;
        v.push(flags);
        if header_le {
            v.extend_from_slice(&srs_id.to_le_bytes());
        } else {
            v.extend_from_slice(&srs_id.to_be_bytes());
        }
        // Reuse the production envelope sizing so the test header cannot drift from it.
        let env = envelope_len(env_indicator).unwrap_or(0);
        v.extend(std::iter::repeat_n(0u8, env));
        v.extend_from_slice(wkb);
        v
    }

    fn put_u32(v: &mut Vec<u8>, n: u32, le: bool) {
        if le {
            v.extend_from_slice(&n.to_le_bytes());
        } else {
            v.extend_from_slice(&n.to_be_bytes());
        }
    }

    fn put_f64(v: &mut Vec<u8>, x: f64, le: bool) {
        if le {
            v.extend_from_slice(&x.to_le_bytes());
        } else {
            v.extend_from_slice(&x.to_be_bytes());
        }
    }

    fn wkb_polygon(le: bool, rings: &[&[Point]]) -> Vec<u8> {
        let mut v = vec![if le { 1 } else { 0 }];
        put_u32(&mut v, WKB_POLYGON, le);
        put_u32(&mut v, rings.len() as u32, le);
        for ring in rings {
            put_u32(&mut v, ring.len() as u32, le);
            for p in *ring {
                put_f64(&mut v, p[0], le);
                put_f64(&mut v, p[1], le);
            }
        }
        v
    }

    fn wkb_multipolygon(outer_le: bool, parts: &[(bool, Vec<&[Point]>)]) -> Vec<u8> {
        let mut v = vec![if outer_le { 1 } else { 0 }];
        put_u32(&mut v, WKB_MULTIPOLYGON, outer_le);
        put_u32(&mut v, parts.len() as u32, outer_le);
        for (part_le, rings) in parts {
            v.extend_from_slice(&wkb_polygon(*part_le, rings));
        }
        v
    }

    // A small but real-looking square ring (closed) in lon/lat.
    const SQUARE: [Point; 5] = [
        [-122.5, 37.7],
        [-122.5, 37.8],
        [-122.4, 37.8],
        [-122.4, 37.7],
        [-122.5, 37.7],
    ];

    #[test]
    fn polygon_little_endian_no_envelope() {
        let wkb = wkb_polygon(true, &[&SQUARE]);
        let blob = gp_blob(true, 0, 4326, &wkb);
        let g = decode(&blob).expect("decode");
        assert_eq!(g.srs_id, 4326);
        assert_eq!(g.kind, GeometryKind::Polygon);
        assert_eq!(g.polygons.len(), 1);
        assert_eq!(g.ring_count(), 1);
        assert_eq!(g.vertex_count(), 5);
        assert_eq!(g.first_ring().unwrap()[0], [-122.5, 37.7]);
        assert_eq!(g.bounds(), Some([-122.5, 37.7, -122.4, 37.8]));
    }

    #[test]
    fn polygon_big_endian_with_xy_envelope() {
        // Big-endian header AND big-endian WKB, with a 32-byte XY envelope present.
        let wkb = wkb_polygon(false, &[&SQUARE]);
        let blob = gp_blob(false, 1, 4326, &wkb);
        let g = decode(&blob).expect("decode");
        assert_eq!(g.srs_id, 4326);
        assert_eq!(g.kind, GeometryKind::Polygon);
        assert_eq!(g.vertex_count(), 5);
        assert_eq!(g.first_ring().unwrap()[0], [-122.5, 37.7]);
    }

    #[test]
    fn polygon_with_hole_counts_both_rings() {
        let hole: [Point; 5] = [
            [-122.47, 37.73],
            [-122.47, 37.77],
            [-122.43, 37.77],
            [-122.43, 37.73],
            [-122.47, 37.73],
        ];
        let wkb = wkb_polygon(true, &[&SQUARE, &hole]);
        let blob = gp_blob(true, 1, 4326, &wkb);
        let g = decode(&blob).expect("decode");
        assert_eq!(g.ring_count(), 2);
        assert_eq!(g.vertex_count(), 10);
    }

    #[test]
    fn multipolygon_little_endian() {
        let other: [Point; 4] = [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [0.0, 0.0]];
        let wkb = wkb_multipolygon(true, &[(true, vec![&SQUARE]), (true, vec![&other])]);
        let blob = gp_blob(true, 1, 4326, &wkb);
        let g = decode(&blob).expect("decode");
        assert_eq!(g.kind, GeometryKind::MultiPolygon);
        assert_eq!(g.polygons.len(), 2);
        assert_eq!(g.vertex_count(), 9);
        assert_eq!(g.geom_type_name(), "MultiPolygon");
    }

    #[test]
    fn multipolygon_mixed_byte_orders() {
        // Outer little-endian, parts big-endian: WKB allows each part its own order.
        let other: [Point; 4] = [[10.0, 10.0], [10.0, 11.0], [11.0, 11.0], [10.0, 10.0]];
        let wkb = wkb_multipolygon(true, &[(false, vec![&SQUARE]), (false, vec![&other])]);
        let blob = gp_blob(false, 0, 4326, &wkb);
        let g = decode(&blob).expect("decode");
        assert_eq!(g.kind, GeometryKind::MultiPolygon);
        assert_eq!(g.polygons.len(), 2);
        assert_eq!(g.vertex_count(), 9);
    }

    #[test]
    fn bad_magic_is_rejected() {
        let wkb = wkb_polygon(true, &[&SQUARE]);
        let mut blob = gp_blob(true, 0, 4326, &wkb);
        blob[0] = 0x00;
        assert_eq!(decode(&blob), Err(GpkgError::BadMagic([0x00, 0x50])));
    }

    #[test]
    fn truncated_blob_is_rejected() {
        let wkb = wkb_polygon(true, &[&SQUARE]);
        let blob = gp_blob(true, 0, 4326, &wkb);
        let cut = &blob[..blob.len() - 8]; // drop the last vertex's y coordinate
        assert_eq!(decode(cut), Err(GpkgError::TooShort));
    }

    #[test]
    fn unsupported_type_is_reported() {
        // A WKB Point (type 1) is valid WKB but out of scope for this spike.
        let mut wkb = vec![1u8];
        put_u32(&mut wkb, 1, true);
        put_f64(&mut wkb, -122.4, true);
        put_f64(&mut wkb, 37.7, true);
        let blob = gp_blob(true, 0, 4326, &wkb);
        assert_eq!(decode(&blob), Err(GpkgError::UnsupportedWkbType(1)));
    }

    #[test]
    fn empty_flag_yields_no_polygons() {
        // Empty geometry bit set, no WKB body.
        let mut blob = vec![0x47, 0x50, 0x00, 0x01 | 0x10];
        blob.extend_from_slice(&4326i32.to_le_bytes());
        let g = decode(&blob).expect("decode");
        assert_eq!(g.kind, GeometryKind::Empty);
        assert_eq!(g.vertex_count(), 0);
        assert_eq!(g.bounds(), None);
    }
}

#[cfg(test)]
mod lift_tests {
    use super::*;

    // GeoPackage blob: "GP", version 0, flags 0x01 (LE, no envelope), srs_id 4326,
    // then WKB Polygon with one ring of a unit square at lon 10..11, lat 50..51.
    fn unit_square_blob() -> Vec<u8> {
        let mut b = vec![0x47, 0x50, 0x00, 0x01]; // magic, version, flags
        b.extend_from_slice(&4326i32.to_le_bytes()); // srs_id
        b.push(0x01); // WKB byte order: little endian
        b.extend_from_slice(&3u32.to_le_bytes()); // WKB type: Polygon
        b.extend_from_slice(&1u32.to_le_bytes()); // ring count
        b.extend_from_slice(&5u32.to_le_bytes()); // point count (closed ring)
        for (lon, lat) in [(10.0, 50.0), (11.0, 50.0), (11.0, 51.0), (10.0, 51.0), (10.0, 50.0)] {
            b.extend_from_slice(&(lon as f64).to_le_bytes());
            b.extend_from_slice(&(lat as f64).to_le_bytes());
        }
        b
    }

    #[test]
    fn decodes_lon_lat_polygon() {
        let g = decode(&unit_square_blob()).unwrap();
        assert_eq!(g.srs_id, 4326);
        assert_eq!(g.kind, GeometryKind::Polygon);
        assert_eq!(g.polygons.len(), 1);
        let ring = &g.polygons[0].rings[0];
        assert_eq!(ring[0], [10.0, 50.0]); // [lon, lat], not [lat, lon]
        assert_eq!(ring[2], [11.0, 51.0]);
    }
}
