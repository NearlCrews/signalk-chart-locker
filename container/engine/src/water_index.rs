//! The route's water index: a uniform-grid spatial index over the charted areas and
//! tile water, plus the polygon-resolution re-checks the orchestrator runs over it.
//! Split out of channel_router.rs so the orchestrator holds only build_water_index,
//! route_legs_on_water, and used_tile_water as entry points; the index internals stay
//! private here.

use crate::clock::over_deadline;
use crate::geometry::{bounds_of_rings, point_in_rings, sample_rhumb_leg, union_bbox};
use crate::types::{Bbox, ChartedAreas, Position, Rings, TileWater};

/// A tile-water or ENC land polygon with its precomputed outer-extent bbox. The rings are
/// borrowed from the provider's `bands`/`water`, which outlive the index, so the index is
/// built without cloning every polygon's vertices.
struct IndexedPoly<'a> {
    rings: &'a Rings,
    bbox: Bbox,
}
/// An ENC depth-area polygon with its bbox and decoded `DRVAL1` (shallow_meters), None
/// when unknown.
struct IndexedDepth<'a> {
    rings: &'a Rings,
    bbox: Bbox,
    shallow_meters: Option<f64>,
}

/// A uniform-grid spatial index over a set of bbox-bearing polygons: each bucket lists
/// the polygons whose bbox overlaps it, so a per-point lookup tests only the handful of
/// polygons in that point's bucket. A polygon that contains a point necessarily overlaps
/// the point's bucket, so the lookup is exact, just fast.
struct SpatialBuckets {
    west: f64,
    north: f64,
    inv_lon: f64,
    inv_lat: f64,
    /// Buckets per axis; the grid is square, so this is both the column and row count.
    side: usize,
    cells: Vec<Vec<usize>>,
}

/// A spatial index over a route's charted areas and tile water, built once per route and
/// shared by both border attempts.
pub(crate) struct WaterIndex<'a> {
    land: Vec<IndexedPoly<'a>>,
    depth: Vec<IndexedDepth<'a>>,
    tile: Vec<IndexedPoly<'a>>,
    land_b: SpatialBuckets,
    depth_b: SpatialBuckets,
    tile_b: SpatialBuckets,
}

/// True when a bbox contains the point (touching counts).
fn bbox_contains_point(b: &Bbox, lon: f64, lat: f64) -> bool {
    lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north
}

fn build_buckets(item_bboxes: &[Bbox], union: Bbox) -> SpatialBuckets {
    let lon_span = union.east - union.west;
    let lat_span = union.north - union.south;
    // The union is built from finite bboxes (build_water_index filters non-finite ones),
    // so the spans are always finite here; a degenerate (<= 0) span still no-ops the index.
    if item_bboxes.is_empty() || lon_span <= 0.0 || !lon_span.is_finite() || lat_span <= 0.0 || !lat_span.is_finite() {
        return SpatialBuckets {
            west: 0.0,
            north: 0.0,
            inv_lon: 0.0,
            inv_lat: 0.0,
            side: 0,
            cells: Vec::new(),
        };
    }
    // About sqrt(n) buckets per axis caps both the grid memory and the average bucket
    // occupancy.
    let side = 64.min(1.max((item_bboxes.len() as f64).sqrt().round() as usize));
    let inv_lon = side as f64 / lon_span;
    let inv_lat = side as f64 / lat_span;
    let mut cells: Vec<Vec<usize>> = (0..side * side).map(|_| Vec::new()).collect();
    let clamp = |v: i64| -> usize {
        if v < 0 {
            0
        } else if v > side as i64 - 1 {
            side - 1
        } else {
            v as usize
        }
    };
    for (idx, bbox) in item_bboxes.iter().enumerate() {
        let c0 = clamp(((bbox.west - union.west) * inv_lon).floor() as i64);
        let c1 = clamp(((bbox.east - union.west) * inv_lon).floor() as i64);
        let r0 = clamp(((union.north - bbox.north) * inv_lat).floor() as i64);
        let r1 = clamp(((union.north - bbox.south) * inv_lat).floor() as i64);
        for r in r0..=r1 {
            for c in c0..=c1 {
                cells[r * side + c].push(idx);
            }
        }
    }
    SpatialBuckets {
        west: union.west,
        north: union.north,
        inv_lon,
        inv_lat,
        side,
        cells,
    }
}

/// The candidate polygon indices for a point: its bucket's list, or none when the point
/// is outside the index.
fn bucket_at(b: &SpatialBuckets, lon: f64, lat: f64) -> &[usize] {
    if b.side == 0 {
        return &[];
    }
    let c = ((lon - b.west) * b.inv_lon).floor() as i64;
    let r = ((b.north - lat) * b.inv_lat).floor() as i64;
    if c < 0 || c >= b.side as i64 || r < 0 || r >= b.side as i64 {
        return &[];
    }
    &b.cells[(r as usize) * b.side + c as usize]
}

/// True when all four edges of a bbox are finite. A non-finite bbox arises from
/// empty rings or all-NaN vertices in a provider polygon; such a bbox must not
/// reach union_bbox, which panics on non-finite input.
fn bbox_is_finite(b: &Bbox) -> bool {
    b.north.is_finite() && b.south.is_finite() && b.east.is_finite() && b.west.is_finite()
}

pub(crate) fn build_water_index<'a>(bands: &'a [ChartedAreas], water: &'a TileWater) -> WaterIndex<'a> {
    // Read the per-band charted areas directly, in band order, so the index holds the
    // same polygons in the same order a flattened copy would, without the intermediate
    // clone of every area. Polygons whose bounds_of_rings produces a non-finite bbox
    // (empty rings, all-NaN vertices) are silently skipped rather than panicking in
    // union_bbox. All corpus polygons have finite vertices, so this filter never fires
    // on any corpus case.
    let land: Vec<IndexedPoly<'a>> = bands
        .iter()
        .flat_map(|b| b.land_areas.iter())
        .filter_map(|a| {
            let bbox = bounds_of_rings(&a.rings);
            // The WKB decoder upstream fails loud on undecodable geometry, so a non-finite
            // obstacle bbox should never reach here at runtime; the debug_assert catches a
            // regression in a debug or test build. The release filter is kept so a stray
            // NaN can never be indexed (and later read as navigable) in production.
            debug_assert!(
                bbox_is_finite(&bbox) || a.rings.iter().all(|r| r.is_empty()),
                "build_water_index: non-finite land bbox from non-empty rings reached the index"
            );
            if !bbox_is_finite(&bbox) {
                return None;
            }
            Some(IndexedPoly { rings: &a.rings, bbox })
        })
        .collect();
    let depth: Vec<IndexedDepth<'a>> = bands
        .iter()
        .flat_map(|b| b.depth_areas.iter())
        .filter_map(|a| {
            let bbox = bounds_of_rings(&a.rings);
            debug_assert!(
                bbox_is_finite(&bbox) || a.rings.iter().all(|r| r.is_empty()),
                "build_water_index: non-finite depth bbox from non-empty rings reached the index"
            );
            if !bbox_is_finite(&bbox) {
                return None;
            }
            Some(IndexedDepth {
                rings: &a.rings,
                bbox,
                shallow_meters: a.depth_range.as_ref().and_then(|d| d.shallow_meters),
            })
        })
        .collect();
    let tile: Vec<IndexedPoly<'a>> = water
        .water
        .iter()
        .filter_map(|w| {
            let bbox = bounds_of_rings(&w.rings);
            debug_assert!(
                bbox_is_finite(&bbox) || w.rings.iter().all(|r| r.is_empty()),
                "build_water_index: non-finite tile-water bbox from non-empty rings reached the index"
            );
            if !bbox_is_finite(&bbox) {
                return None;
            }
            Some(IndexedPoly { rings: &w.rings, bbox })
        })
        .collect();
    // The union seeds the bucket grids. The caller declines no-coverage before building
    // the index, so there is at least one polygon; the degenerate box is a defensive
    // fallback that build_buckets no-ops on. The land, depth, and tile order matches the
    // reference, though union is order-independent.
    let mut union: Option<Bbox> = None;
    for p in &land {
        union = Some(match union {
            None => p.bbox,
            Some(u) => union_bbox(u, p.bbox),
        });
    }
    for p in &depth {
        union = Some(match union {
            None => p.bbox,
            Some(u) => union_bbox(u, p.bbox),
        });
    }
    for p in &tile {
        union = Some(match union {
            None => p.bbox,
            Some(u) => union_bbox(u, p.bbox),
        });
    }
    let union = union.unwrap_or(Bbox {
        north: 0.0,
        south: 0.0,
        east: 0.0,
        west: 0.0,
    });
    let land_bboxes: Vec<Bbox> = land.iter().map(|p| p.bbox).collect();
    let depth_bboxes: Vec<Bbox> = depth.iter().map(|p| p.bbox).collect();
    let tile_bboxes: Vec<Bbox> = tile.iter().map(|p| p.bbox).collect();
    WaterIndex {
        land_b: build_buckets(&land_bboxes, union),
        depth_b: build_buckets(&depth_bboxes, union),
        tile_b: build_buckets(&tile_bboxes, union),
        land,
        depth,
        tile,
    }
}

/// True when a point lies inside a bbox-indexed polygon: the cheap bbox reject, then the
/// exact ray cast.
fn point_in_indexed_land(poly: &IndexedPoly<'_>, lon: f64, lat: f64) -> bool {
    bbox_contains_point(&poly.bbox, lon, lat) && point_in_rings(lon, lat, poly.rings)
}
fn point_in_indexed_depth(poly: &IndexedDepth<'_>, lon: f64, lat: f64) -> bool {
    bbox_contains_point(&poly.bbox, lon, lat) && point_in_rings(lon, lat, poly.rings)
}

/// True when a point is inside an ENC depth area charted deep enough (defined
/// `DRVAL1 >= contour`).
fn in_enc_deep(lon: f64, lat: f64, index: &WaterIndex<'_>, contour: f64) -> bool {
    for &i in bucket_at(&index.depth_b, lon, lat) {
        let a = &index.depth[i];
        if let Some(sm) = a.shallow_meters {
            if sm >= contour && point_in_indexed_depth(a, lon, lat) {
                return true;
            }
        }
    }
    false
}

/// Whether a point is ON NAVIGABLE WATER for the re-check: off water only inside ENC
/// land, inside an ENC drying area (charted `DRVAL1 < 0`), or outside all water; a point
/// in any other ENC depth area or in tile water is on water. Depth adequacy is the safety
/// check's job, not this check's.
fn navigable_at(lon: f64, lat: f64, index: &WaterIndex<'_>) -> bool {
    for &i in bucket_at(&index.land_b, lon, lat) {
        if point_in_indexed_land(&index.land[i], lon, lat) {
            return false;
        }
    }
    let mut in_enc_water = false;
    for &i in bucket_at(&index.depth_b, lon, lat) {
        let a = &index.depth[i];
        if !point_in_indexed_depth(a, lon, lat) {
            continue;
        }
        if let Some(sm) = a.shallow_meters {
            if sm < 0.0 {
                return false; // drying: exposed at low tide, treat as land
            }
        }
        in_enc_water = true;
    }
    if in_enc_water {
        return true;
    }
    for &i in bucket_at(&index.tile_b, lon, lat) {
        if point_in_indexed_land(&index.tile[i], lon, lat) {
            return true;
        }
    }
    false
}

/// True when a single final leg stays on navigable water. It fails only when the leg runs
/// OFF water for a CONTINUOUS stretch longer than `tolerance_meters`; a shorter off-water
/// run is a sub-cell clip below the grid's resolution and is tolerated. The off-water run
/// counter resets on any on-water sample, and both endpoints are tested explicitly.
fn leg_stays_on_water(
    a: Position,
    b: Position,
    index: &WaterIndex<'_>,
    sample_spacing_meters: f64,
    tolerance_meters: f64,
) -> bool {
    let spacing = sample_spacing_meters.max(1.0);
    let mut off_run = 0.0_f64;
    let mut ok = |p: Position| -> bool {
        if navigable_at(p.longitude, p.latitude, index) {
            off_run = 0.0;
            return true;
        }
        off_run += 1.0;
        off_run * spacing <= tolerance_meters
    };
    if !ok(a) {
        return false;
    }
    for s in sample_rhumb_leg(a, b, spacing) {
        if !ok(s) {
            return false;
        }
    }
    ok(b)
}

/// True when no final leg leaves navigable water. The router's honesty backstop at full
/// polygon resolution over a prebuilt index.
pub(crate) fn route_legs_on_water(
    waypoints: &[Position],
    index: &WaterIndex<'_>,
    sample_spacing_meters: f64,
    tolerance_meters: f64,
    deadline_ms: Option<f64>,
) -> bool {
    let mut i = 0;
    while i + 1 < waypoints.len() {
        if over_deadline(deadline_ms) {
            return false;
        }
        if !leg_stays_on_water(
            waypoints[i],
            waypoints[i + 1],
            index,
            sample_spacing_meters,
            tolerance_meters,
        ) {
            return false;
        }
        i += 1;
    }
    true
}

/// True when any sampled point along the route sits on tile water rather than inside an
/// ENC deep-enough area, so the route earns the depth-unverified caveat. Uses the same
/// `in_enc_deep` predicate the re-check uses.
pub(crate) fn used_tile_water(
    waypoints: &[Position],
    index: &WaterIndex<'_>,
    contour: f64,
    sample_spacing_meters: f64,
    deadline_ms: Option<f64>,
) -> bool {
    if index.tile.is_empty() {
        return false;
    }
    let spacing = sample_spacing_meters.max(1.0);
    let on_tile_water = |p: Position| -> bool {
        if in_enc_deep(p.longitude, p.latitude, index, contour) {
            return false;
        }
        for &i in bucket_at(&index.tile_b, p.longitude, p.latitude) {
            if point_in_indexed_land(&index.tile[i], p.longitude, p.latitude) {
                return true;
            }
        }
        false
    };
    let mut i = 0;
    while i + 1 < waypoints.len() {
        // Past the deadline, keep the depth-unverified caveat (the conservative direction)
        // rather than spending more budget proving it.
        if over_deadline(deadline_ms) {
            return true;
        }
        let a = waypoints[i];
        let b = waypoints[i + 1];
        if on_tile_water(a) || on_tile_water(b) {
            return true;
        }
        for p in sample_rhumb_leg(a, b, spacing) {
            if on_tile_water(p) {
                return true;
            }
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AreaPolygon, EncAreaPolygon, TileWater};

    /// A polygon with empty rings has a non-finite bbox from bounds_of_rings. The
    /// build_water_index function must skip it (via bbox_is_finite) rather than
    /// panicking in union_bbox.
    #[test]
    fn build_water_index_skips_empty_ring_polygon_without_panicking() {
        let water = TileWater {
            water: vec![AreaPolygon { rings: vec![] }],
        };
        // Should not panic.
        let index = build_water_index(&[], &water);
        // The degenerate polygon contributes nothing: tile list is empty after the filter.
        assert!(index.tile.is_empty());
    }

    /// A land area polygon with empty rings is also skipped without panicking.
    #[test]
    fn build_water_index_skips_empty_ring_land_area_without_panicking() {
        let areas = ChartedAreas {
            land_areas: vec![EncAreaPolygon { rings: vec![], depth_range: None }],
            depth_areas: vec![],
        };
        let water = TileWater { water: vec![] };
        let bands = [areas];
        let index = build_water_index(&bands, &water);
        assert!(index.land.is_empty());
    }
}
