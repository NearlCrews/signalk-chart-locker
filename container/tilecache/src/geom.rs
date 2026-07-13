//! The Web Mercator inverse and a lazy tile enumerator, the Rust mirror of the shared package
//! `tileForLngLat`, `tilesInBbox`, and `tileCountInBbox`. Same formula as the TS copy (same-formula
//! parity, not bit-exact: the container hard-stops at the cap, so a boundary-tile difference between the
//! TS estimate and this enumeration is harmless). Used by the warm engine.

use crate::source::ChartSource;
use std::f64::consts::PI;

/// The Web Mercator latitude limit (about plus or minus 85.0511 degrees).
pub const MAX_MERCATOR_LAT: f64 = 85.0511287798066;

/// The standard slippy-tile floor: the integer tile x/y at zoom z that contains (lng, lat). The result
/// is clamped into [0, 2^z - 1].
pub fn tile_for_lng_lat(lng: f64, lat: f64, z: u32) -> (u32, u32) {
    let n = 2f64.powi(z as i32);
    let clamped = lat.clamp(-MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
    let lat_rad = clamped.to_radians();
    let xf = (((lng + 180.0) / 360.0) * n).floor();
    let yf = (((1.0 - lat_rad.tan().asinh() / PI) / 2.0) * n).floor();
    let max = (n as i64 - 1).max(0);
    let xi = (xf as i64).clamp(0, max) as u32;
    let yi = (yf as i64).clamp(0, max) as u32;
    (xi, yi)
}

fn split_bbox([west, south, east, north]: [f64; 4]) -> Vec<[f64; 4]> {
    if west < east {
        vec![[west, south, east, north]]
    } else if west > east {
        vec![[west, south, 180.0, north], [-180.0, south, east, north]]
    } else {
        Vec::new()
    }
}

fn intersect(left: [f64; 4], right: [f64; 4]) -> Option<[f64; 4]> {
    let west = left[0].max(right[0]);
    let south = left[1].max(right[1]).max(-MAX_MERCATOR_LAT);
    let east = left[2].min(right[2]);
    let north = left[3].min(right[3]).min(MAX_MERCATOR_LAT);
    (west < east && south < north).then_some([west, south, east, north])
}

// Split antimeridian-crossing request and source boxes, intersect them with the source's disjoint
// coverage (or its display bounds), and clamp latitude to Web Mercator.
fn clips(source: &ChartSource, bbox: [f64; 4]) -> Vec<[f64; 4]> {
    if !bbox.iter().all(|v| v.is_finite()) || bbox[0] == bbox[2] || bbox[1] >= bbox[3] {
        return Vec::new();
    }
    let requested = split_bbox(bbox);
    let coverage = source
        .coverage
        .clone()
        .or_else(|| source.bounds.map(|bounds| vec![bounds]))
        .unwrap_or_else(|| vec![[-180.0, -90.0, 180.0, 90.0]]);
    let source_boxes: Vec<[f64; 4]> = coverage.into_iter().flat_map(split_bbox).collect();
    requested
        .into_iter()
        .flat_map(|request| {
            source_boxes
                .iter()
                .filter_map(move |source_box| intersect(request, *source_box))
        })
        .collect()
}

/// The effective zoom ceiling for any warm or enumeration: the source maxzoom capped at 24 so
/// tile coordinates always fit in u32 (2^24 = 16_777_216, well within u32::MAX).
const MAX_EFFECTIVE_ZOOM: u32 = 24;

fn zoom_bounds(source: &ChartSource, zmin: u32, zmax: u32) -> (u32, u32) {
    (
        zmin.max(source.minzoom),
        zmax.min(source.maxzoom).min(MAX_EFFECTIVE_ZOOM),
    )
}

// The inclusive tile rectangle (x0, x1, y0, y1) for the clipped bbox at zoom z. y increases downward, so
// the north edge (max_lat) is the smaller y.
fn tile_rect(clip: [f64; 4], z: u32) -> (u32, u32, u32, u32) {
    let (x0, y0) = tile_for_lng_lat(clip[0], clip[3], z);
    let (x1, y1) = tile_for_lng_lat(clip[2], clip[1], z);
    (x0, x1, y0, y1)
}

#[derive(Clone, Copy)]
struct TileRange {
    z: u32,
    x0: u32,
    x1: u32,
    y0: u32,
    y1: u32,
}

// Convert possibly overlapping rectangles into disjoint x slabs with merged y intervals. This keeps
// overlapping coverage boxes and antimeridian edge tiles from being counted or fetched twice.
fn disjoint_ranges(ranges: Vec<TileRange>) -> Vec<TileRange> {
    let mut out = Vec::new();
    let mut zooms: Vec<u32> = ranges.iter().map(|range| range.z).collect();
    zooms.sort_unstable();
    zooms.dedup();
    for z in zooms {
        let zoom_ranges: Vec<TileRange> = ranges
            .iter()
            .copied()
            .filter(|range| range.z == z)
            .collect();
        let mut boundaries: Vec<u32> = zoom_ranges
            .iter()
            .flat_map(|range| [range.x0, range.x1 + 1])
            .collect();
        boundaries.sort_unstable();
        boundaries.dedup();
        for pair in boundaries.windows(2) {
            let x0 = pair[0];
            let x_end = pair[1];
            if x0 >= x_end {
                continue;
            }
            let mut intervals: Vec<(u32, u32)> = zoom_ranges
                .iter()
                .filter(|range| range.x0 <= x0 && range.x1 >= x_end - 1)
                .map(|range| (range.y0, range.y1))
                .collect();
            intervals.sort_unstable_by_key(|interval| interval.0);
            let mut current: Option<(u32, u32)> = None;
            for interval in intervals {
                current = match current {
                    None => Some(interval),
                    Some((start, end)) if interval.0 <= end.saturating_add(1) => {
                        Some((start, end.max(interval.1)))
                    }
                    Some((start, end)) => {
                        out.push(TileRange {
                            z,
                            x0,
                            x1: x_end - 1,
                            y0: start,
                            y1: end,
                        });
                        Some(interval)
                    }
                };
            }
            if let Some((y0, y1)) = current {
                out.push(TileRange {
                    z,
                    x0,
                    x1: x_end - 1,
                    y0,
                    y1,
                });
            }
        }
    }
    out.sort_unstable_by_key(|range| (range.z, range.x0, range.y0));
    out
}

fn covered_ranges(source: &ChartSource, bbox: [f64; 4], zmin: u32, zmax: u32) -> Vec<TileRange> {
    let clips = clips(source, bbox);
    let (zmin, zmax) = zoom_bounds(source, zmin, zmax);
    if zmin > zmax || clips.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    for z in zmin..=zmax {
        for clip in &clips {
            let (x0, x1, y0, y1) = tile_rect(*clip, z);
            ranges.push(TileRange { z, x0, x1, y0, y1 });
        }
    }
    disjoint_ranges(ranges)
}

/// The number of tiles a warm over this bbox and zoom range would touch.
pub fn tile_count_in_bbox(source: &ChartSource, bbox: [f64; 4], zmin: u32, zmax: u32) -> u64 {
    let mut count = 0;
    for TileRange { x0, x1, y0, y1, .. } in covered_ranges(source, bbox, zmin, zmax) {
        // Widen to u64 BEFORE subtracting so a high-zoom source cannot wrap in u32.
        count += (u64::from(x1) - u64::from(x0) + 1) * (u64::from(y1) - u64::from(y0) + 1);
    }
    count
}

/// An iterator over (z, x, y) for every tile a warm over this bbox and zoom range would touch.
/// Allocates the small set of disjoint coverage ranges and one Box; tile tuples are produced lazily.
pub fn tiles_iter(
    source: &ChartSource,
    bbox: [f64; 4],
    zmin: u32,
    zmax: u32,
) -> Box<dyn Iterator<Item = (u32, u32, u32)> + Send + '_> {
    Box::new(
        covered_ranges(source, bbox, zmin, zmax)
            .into_iter()
            .flat_map(|range| {
                (range.x0..=range.x1)
                    .flat_map(move |x| (range.y0..=range.y1).map(move |y| (range.z, x, y)))
            }),
    )
}

/// Call `f(z, x, y)` for every tile a warm over this bbox and zoom range would touch without
/// collecting the tile tuples.
#[cfg(test)]
pub fn for_tiles_in_bbox(
    source: &ChartSource,
    bbox: [f64; 4],
    zmin: u32,
    zmax: u32,
    mut f: impl FnMut(u32, u32, u32),
) {
    for range in covered_ranges(source, bbox, zmin, zmax) {
        for x in range.x0..=range.x1 {
            for y in range.y0..=range.y1 {
                f(range.z, x, y);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{ChartSource, UpstreamTemplate};

    fn src(minzoom: u32, maxzoom: u32, bounds: Option<[f64; 4]>) -> ChartSource {
        ChartSource {
            id: "s".into(),
            title: "S".into(),
            upstream: UpstreamTemplate::Xyz {
                url_template: "http://h/{z}/{x}/{y}".into(),
            },
            tile_size: 256,
            minzoom,
            maxzoom,
            vector_maxzoom: None,
            bounds,
            coverage: None,
            attribution: String::new(),
        }
    }

    #[test]
    fn tile_for_lng_lat_matches_known_slippy_values() {
        assert_eq!(tile_for_lng_lat(0.0, 0.0, 0), (0, 0));
        assert_eq!(tile_for_lng_lat(0.0, 0.0, 1), (1, 1));
        assert_eq!(tile_for_lng_lat(-180.0, MAX_MERCATOR_LAT, 2), (0, 0));
        assert_eq!(tile_for_lng_lat(179.999, -MAX_MERCATOR_LAT, 2), (3, 3));
    }

    #[test]
    fn latitude_beyond_the_limit_clamps_and_stays_in_range() {
        assert_eq!(
            tile_for_lng_lat(0.0, 89.0, 4),
            tile_for_lng_lat(0.0, MAX_MERCATOR_LAT, 4)
        );
        let (_, y) = tile_for_lng_lat(0.0, 89.0, 4);
        assert!(y < 16);
    }

    #[test]
    fn count_matches_enumeration_and_clamps_zoom() {
        let s = src(5, 8, None);
        let mut n = 0u64;
        for_tiles_in_bbox(&s, [-10.0, 40.0, 10.0, 55.0], 0, 20, |z, _, _| {
            assert!((5..=8).contains(&z));
            n += 1;
        });
        assert_eq!(n, tile_count_in_bbox(&s, [-10.0, 40.0, 10.0, 55.0], 0, 20));
    }

    #[test]
    fn high_zoom_source_clamped_to_24_and_count_does_not_wrap() {
        // A source with maxzoom = 33 must have its effective zoom clamped to MAX_EFFECTIVE_ZOOM (24).
        // Before the fix, x1 - x0 + 1 in u32 wrapped to a tiny value at zoom >= 32, causing
        // tile_count_in_bbox to undercount and the warm hard-cap check to be bypassed.
        let s = src(0, 33, None);
        // Tiny bbox: about 0.001 degree square. At zoom 24 this yields a small, predictable count.
        let count = tile_count_in_bbox(&s, [0.0, 50.0, 0.001, 50.001], 24, 33);
        assert!(
            count >= 1,
            "at least one tile expected after clamping to zoom 24"
        );
        assert!(
            count < 1_000_000,
            "count must not be a u32-wrapped undercount at zoom >= 32"
        );
        // Enumeration and count must agree; all emitted zooms must be <= MAX_EFFECTIVE_ZOOM.
        let mut n = 0u64;
        let mut max_z = 0u32;
        for_tiles_in_bbox(&s, [0.0, 50.0, 0.001, 50.001], 24, 33, |z, _, _| {
            assert!(
                z <= MAX_EFFECTIVE_ZOOM,
                "zoom {z} exceeded MAX_EFFECTIVE_ZOOM"
            );
            max_z = max_z.max(z);
            n += 1;
        });
        assert_eq!(n, count, "enumeration count must match tile_count_in_bbox");
        assert!(max_z <= MAX_EFFECTIVE_ZOOM);
        // tiles_iter must produce the same count.
        let iter_count = tiles_iter(&s, [0.0, 50.0, 0.001, 50.001], 24, 33).count() as u64;
        assert_eq!(
            iter_count, count,
            "tiles_iter count must match tile_count_in_bbox"
        );
    }

    #[test]
    fn bounds_clip_antimeridian_and_invalid_boxes() {
        let bounded = src(0, 18, Some([0.0, 0.0, 5.0, 5.0]));
        let unbounded = src(0, 18, None);
        assert!(
            tile_count_in_bbox(&bounded, [-20.0, -20.0, 20.0, 20.0], 6, 6)
                < tile_count_in_bbox(&unbounded, [-20.0, -20.0, 20.0, 20.0], 6, 6)
        );
        let crossing = [170.0, -10.0, -170.0, 10.0];
        let crossing_tiles: Vec<_> = tiles_iter(&unbounded, crossing, 3, 3).collect();
        assert_eq!(
            tile_count_in_bbox(&unbounded, crossing, 3, 3),
            crossing_tiles.len() as u64
        );
        assert!(!crossing_tiles.is_empty());
        assert_eq!(
            crossing_tiles
                .iter()
                .map(|(_, x, _)| *x)
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from([0, 7])
        );
        assert_eq!(
            tile_count_in_bbox(&unbounded, [5.0, 5.0, 5.0, 5.0], 2, 2),
            0
        ); // degenerate
        assert_eq!(
            tile_count_in_bbox(&unbounded, [f64::NAN, 0.0, 1.0, 1.0], 2, 2),
            0
        ); // non-finite
    }

    #[test]
    fn disjoint_coverage_is_clipped_and_deduplicated() {
        let mut source = src(0, 18, None);
        source.coverage = Some(vec![
            [160.0, -15.0, 180.0, 15.0],
            [-180.0, -15.0, -160.0, 15.0],
            [170.0, -10.0, -170.0, 10.0],
        ]);
        let bbox = [150.0, -20.0, -150.0, 20.0];
        let tiles: Vec<_> = tiles_iter(&source, bbox, 2, 2).collect();
        assert_eq!(tile_count_in_bbox(&source, bbox, 2, 2), tiles.len() as u64);
        let unique: std::collections::HashSet<_> = tiles.iter().copied().collect();
        assert_eq!(
            unique.len(),
            tiles.len(),
            "overlapping coverage must not duplicate tiles"
        );
    }
}
