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

// Clip the request bbox to the source bounds and the Mercator latitude limit. Returns the clipped bbox,
// or None if the box is non-finite, degenerate, antimeridian-crossing (min_lng > max_lng), or wholly
// outside the source bounds.
fn clip(source: &ChartSource, bbox: [f64; 4]) -> Option<[f64; 4]> {
    let [mut min_lng, mut min_lat, mut max_lng, mut max_lat] = bbox;
    if !bbox.iter().all(|v| v.is_finite()) {
        return None;
    }
    if min_lng > max_lng {
        return None;
    }
    if let Some([b0, b1, b2, b3]) = source.bounds {
        min_lng = min_lng.max(b0);
        min_lat = min_lat.max(b1);
        max_lng = max_lng.min(b2);
        max_lat = max_lat.min(b3);
    }
    min_lat = min_lat.max(-MAX_MERCATOR_LAT);
    max_lat = max_lat.min(MAX_MERCATOR_LAT);
    if min_lng >= max_lng || min_lat >= max_lat {
        return None;
    }
    Some([min_lng, min_lat, max_lng, max_lat])
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

/// The number of tiles a warm over this bbox and zoom range would touch.
pub fn tile_count_in_bbox(source: &ChartSource, bbox: [f64; 4], zmin: u32, zmax: u32) -> u64 {
    let Some(c) = clip(source, bbox) else {
        return 0;
    };
    let (zmin, zmax) = zoom_bounds(source, zmin, zmax);
    let mut count = 0u64;
    for z in zmin..=zmax {
        let (x0, x1, y0, y1) = tile_rect(c, z);
        // Widen to u64 BEFORE subtracting so a high-zoom source cannot wrap in u32.
        count += (u64::from(x1) - u64::from(x0) + 1) * (u64::from(y1) - u64::from(y0) + 1);
    }
    count
}

/// An iterator over (z, x, y) for every tile a warm over this bbox and zoom range would touch.
/// Allocates one Box (the trait object); the tile tuples are produced lazily.
pub fn tiles_iter(
    source: &ChartSource,
    bbox: [f64; 4],
    zmin: u32,
    zmax: u32,
) -> Box<dyn Iterator<Item = (u32, u32, u32)> + Send + '_> {
    let Some(c) = clip(source, bbox) else {
        return Box::new(std::iter::empty());
    };
    let (zmin, zmax) = zoom_bounds(source, zmin, zmax);
    Box::new((zmin..=zmax).flat_map(move |z| {
        let (x0, x1, y0, y1) = tile_rect(c, z);
        (x0..=x1).flat_map(move |x| (y0..=y1).map(move |y| (z, x, y)))
    }))
}

/// Call `f(z, x, y)` for every tile a warm over this bbox and zoom range would touch, allocating nothing.
#[cfg(test)]
pub fn for_tiles_in_bbox(
    source: &ChartSource,
    bbox: [f64; 4],
    zmin: u32,
    zmax: u32,
    mut f: impl FnMut(u32, u32, u32),
) {
    let Some(c) = clip(source, bbox) else { return };
    let (zmin, zmax) = zoom_bounds(source, zmin, zmax);
    for z in zmin..=zmax {
        let (x0, x1, y0, y1) = tile_rect(c, z);
        for x in x0..=x1 {
            for y in y0..=y1 {
                f(z, x, y);
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
    fn bounds_clip_and_antimeridian_and_degenerate_are_rejected() {
        let bounded = src(0, 18, Some([0.0, 0.0, 5.0, 5.0]));
        let unbounded = src(0, 18, None);
        assert!(
            tile_count_in_bbox(&bounded, [-20.0, -20.0, 20.0, 20.0], 6, 6)
                < tile_count_in_bbox(&unbounded, [-20.0, -20.0, 20.0, 20.0], 6, 6)
        );
        assert_eq!(
            tile_count_in_bbox(&unbounded, [170.0, -10.0, -170.0, 10.0], 3, 3),
            0
        ); // antimeridian
        assert_eq!(
            tile_count_in_bbox(&unbounded, [5.0, 5.0, 5.0, 5.0], 2, 2),
            0
        ); // degenerate
        assert_eq!(
            tile_count_in_bbox(&unbounded, [f64::NAN, 0.0, 1.0, 1.0], 2, 2),
            0
        ); // non-finite
    }
}
