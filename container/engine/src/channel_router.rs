//! The channel router orchestrator, ported from `channel-router.ts`: validate and
//! size the bbox, gather provider data, build the grid, snap the endpoints, run A*,
//! simplify, re-validate every leg at polygon resolution, and return the waypoints
//! or a typed decline. The snap ring order, the largest-component tie-break, and the
//! `used_tile_water` and `border_fallback` flag semantics must match the reference.
//!
//! With no deadline the router never reads the wall clock for any decision, so it is
//! a pure function of the request and the provider responses. That is what makes the
//! replay corpus an exact parity oracle.

use std::collections::HashMap;

use crate::astar::{find_path, AStarGrid, PathStatus};
use crate::clock::{now_ms, over_deadline};
use crate::geometry::{
    bounds_of_rings, distance_meters, point_in_rings, route_bbox, sample_rhumb_leg, union_bbox,
    METERS_PER_NAUTICAL_MILE,
};
use crate::nav_grid::{build_nav_grid, resolve_grid_size, NavGrid, NavGridParams, ORTHO_NEIGHBORS};
use crate::path_simplify::simplify_path;
use crate::types::{
    Bbox, ChannelDeclineReason, ChannelRouteRequest, ChannelRouteResult, ChartedAreas, Position,
    Provider, RingPolygon, Rings, ScaleBand, TileWater,
};

/// Default cap an endpoint may be snapped to navigable water: two nautical miles, so a
/// near-shore waypoint can reach the navigable channel a mile or two out.
const DEFAULT_MAX_SNAP_METERS: f64 = 2.0 * METERS_PER_NAUTICAL_MILE;
/// Padding around the bbox anchors, in meters, at least the snap cap so the water an
/// endpoint may snap to is inside the grid.
const BBOX_PAD_METERS: f64 = DEFAULT_MAX_SNAP_METERS;
/// RDP epsilon, in cells, before the per-grid metric cap below.
const SIMPLIFY_EPSILON_CELLS: f64 = 1.5;
/// RDP deviation cap, in meters, so a coarsened grid does not collapse a real bend.
const SIMPLIFY_EPSILON_METERS: f64 = 50.0;
/// Re-check sampling spacing cap, in meters, so a coarsened grid does not widen the
/// sampling past it.
const SAMPLE_CAP_METERS: f64 = 30.0;
/// Minimum remaining budget to attempt the unconstrained fallback after an in-country
/// route failed. Only consulted when a deadline is set, which the corpus never does.
const ROUTER_FALLBACK_MIN_MS: f64 = 2000.0;

/// Compute a water-following route. With no deadline this is a pure function of the
/// request and the provider responses, which is what makes the replay corpus an
/// exact parity oracle. `bands` lists the usage bands to query, finest first.
pub fn route_channel(
    provider: &dyn Provider,
    bands: &[ScaleBand],
    req: &ChannelRouteRequest,
) -> ChannelRouteResult {
    let anchors: Vec<Position> = if let Some(a) = &req.bbox_anchors {
        a.clone()
    } else if let Some(c) = &req.corridor {
        c.clone()
    } else {
        vec![req.from, req.to]
    };
    // route_bbox has no box to seed from an empty anchor list, and the TypeScript
    // reference throws in that case. Decline cleanly instead of panicking. No corpus case
    // exercises this, so the proven parity is unaffected.
    if anchors.is_empty() {
        return ChannelRouteResult::Decline {
            reason: ChannelDeclineReason::NoCoverage,
        };
    }
    // Guard: a non-finite coordinate (NaN or Inf) in from, to, anchors, or corridor
    // must not reach route_bbox, which panics via position_to_bbox on non-finite input.
    // All corpus inputs are finite, so this guard never fires on any corpus case.
    let coord_finite = |p: &Position| p.latitude.is_finite() && p.longitude.is_finite();
    let inputs_finite = coord_finite(&req.from)
        && coord_finite(&req.to)
        && anchors.iter().all(|p| coord_finite(p))
        && req.corridor.as_deref().unwrap_or(&[]).iter().all(|p| coord_finite(p));
    if !inputs_finite {
        return ChannelRouteResult::Decline {
            reason: ChannelDeclineReason::NoCoverage,
        };
    }
    let bbox = route_bbox(&anchors, BBOX_PAD_METERS);
    // Decline a degenerate, cross-antimeridian, or too-large-to-resolve bbox BEFORE any
    // fetch, using the grid's own size resolution so the pre-fetch decline matches what
    // build_nav_grid would reject.
    if resolve_grid_size(bbox, None).is_none() {
        return ChannelRouteResult::Decline {
            reason: ChannelDeclineReason::NoCoverage,
        };
    }

    // Fetch the ENC bands and the tile water. A band returns None when its fetch
    // rejected; the ENC view is "absent" only when every queried band rejected. Tile
    // water is absent when every tile failed. Both absent is fetch-failed. `bands_list`
    // is empty exactly when every band rejected, which is the `encBands ?? []` list
    // either way.
    let mut bands_list: Vec<ChartedAreas> = Vec::new();
    for &band in bands {
        if let Some(areas) = provider.charted_areas(band, bbox) {
            bands_list.push(areas);
        }
    }
    let enc_present = !bands_list.is_empty();
    let tile = provider.tile_water(bbox);
    if !enc_present && tile.is_none() {
        return ChannelRouteResult::Decline {
            reason: ChannelDeclineReason::FetchFailed,
        };
    }

    let water: TileWater = tile.unwrap_or_default();
    // No coverage when no band charts a depth area and no tile water covers the window.
    let has_depth = bands_list.iter().any(|b| !b.depth_areas.is_empty());
    if !has_depth && water.water.is_empty() {
        return ChannelRouteResult::Decline {
            reason: ChannelDeclineReason::NoCoverage,
        };
    }

    // One bbox index over the route's physical water (charted areas plus tile water),
    // shared by both attempts. It reads the per-band charted areas directly, in band
    // order, so a finer band's polygons precede a coarser band's, matching the reference.
    // The foreign block is jurisdictional and lives only in the grid, so the water
    // re-check is identical for the in-country attempt and the unconstrained fallback.
    let index = build_water_index(&bands_list, &water);

    // Build the grid and route across it, optionally blocking foreign water. A closure so
    // the border fallback can run it again without the block, reusing the fetched data.
    let attempt = |foreign_block: &[RingPolygon]| -> ChannelRouteResult {
        // channel-router.ts conventions folded into build_nav_grid: pass the RAW
        // standoff in nautical miles and the RAW corridor polyline (build_nav_grid bakes
        // the 1852 m/NM conversion and the one-nautical-mile corridor half-width), and a
        // None target cell size and empty OSM land, matching the router's own call.
        let params = NavGridParams {
            bbox,
            bands: &bands_list,
            tile_water: Some(&water),
            osm_land: &[],
            foreign_rings: foreign_block,
            draft_meters: req.draft_meters,
            safety_margin_meters: req.safety_margin_meters,
            standoff_nm: req.standoff_nm,
            corridor: req.corridor.as_deref(),
            target_cell_meters: None,
            deadline_ms: req.deadline_ms,
        };
        let grid = build_nav_grid(&params);
        if !grid.has_water() {
            return ChannelRouteResult::Decline {
                reason: ChannelDeclineReason::NoCoverage,
            };
        }

        let max_snap = req.max_snap_meters.unwrap_or(DEFAULT_MAX_SNAP_METERS);
        let (start, goal, main_water) = match snap_endpoints(&grid, req.from, req.to, max_snap) {
            SnapResult::Decline(reason) => return ChannelRouteResult::Decline { reason },
            SnapResult::Snapped { start, goal, comp } => (start, goal, comp),
        };

        // Both endpoints can snap to one cell when they sit within a cell of each other.
        // A* would return a single-cell path, a degenerate one-waypoint success with no
        // legs to safety-check, so decline instead.
        if start.0 == goal.0 && start.1 == goal.1 {
            return ChannelRouteResult::Decline {
                reason: ChannelDeclineReason::NoPath,
            };
        }

        let mut path_status = PathStatus::default();
        let cells = match find_path(&grid, start, goal, req.deadline_ms, Some(&mut path_status)) {
            Some(c) => c,
            None => {
                let reason = if path_status.timed_out {
                    ChannelDeclineReason::Deadline
                } else {
                    ChannelDeclineReason::NoPath
                };
                return ChannelRouteResult::Decline { reason };
            }
        };

        let cols = grid.cols();
        let cell_meters = grid.size().cell_meters;
        let contour = req.draft_meters + req.safety_margin_meters;
        let sample_spacing = (cell_meters / 2.0).min(SAMPLE_CAP_METERS);
        // A leg may run off water for up to one cell: a sub-cell clip is below the grid's
        // resolution, tolerated here and left to the per-leg safety check.
        let clip_tolerance = cell_meters;
        // The repair and decimate passes check legs against the router's own grid, not the
        // full-resolution polygons; routeLegsOnWater below is the polygon honesty backstop.
        let leg_safe = |a: Position, b: Position| -> bool { leg_on_grid(&grid, a, b, sample_spacing) };

        // Simplify the A* centerline to turning points, then repair: a simplified leg that
        // would leave water (an RDP chord cutting a concave shore) is replaced by the A*
        // sub-path it spanned, which is land-safe at cell resolution.
        let epsilon = SIMPLIFY_EPSILON_CELLS.min(SIMPLIFY_EPSILON_METERS / cell_meters);
        let cell_points: Vec<[f64; 2]> = cells.iter().map(|&(c, r)| [c as f64, r as f64]).collect();
        let simplified = simplify_path(&cell_points, epsilon);
        // A collision-free integer key (col + row * cols) maps each A* cell to its index.
        let mut index_by_cell: HashMap<usize, usize> = HashMap::with_capacity(cells.len());
        for (i, &(c, r)) in cells.iter().enumerate() {
            index_by_cell.insert(c + r * cols, i);
        }
        let mut kept_idx: Vec<usize> = Vec::with_capacity(simplified.len());
        for c in &simplified {
            let key = (c[0] as usize) + (c[1] as usize) * cols;
            match index_by_cell.get(&key) {
                Some(&idx) => kept_idx.push(idx),
                // Invariant: simplify_path returns a subset of `cells`. Treat the
                // impossible miss as a safe decline, never a silent route through cells[0].
                None => {
                    return ChannelRouteResult::Decline {
                        reason: ChannelDeclineReason::LandLeg,
                    }
                }
            }
        }
        let mut route_cells: Vec<(usize, usize)> = vec![cells[kept_idx[0]]];
        for k in 1..kept_idx.len() {
            // Mirrors the TypeScript: the repair loop does not propagate a timed-out
            // reason, it declines as LandLeg. Do not "correct" this to Deadline; that
            // would break parity with the reference.
            if over_deadline(req.deadline_ms) {
                return ChannelRouteResult::Decline {
                    reason: ChannelDeclineReason::LandLeg,
                };
            }
            let p = kept_idx[k - 1];
            let q = kept_idx[k];
            if leg_safe(grid.cell_center(cells[p]), grid.cell_center(cells[q])) {
                route_cells.push(cells[q]);
            } else {
                for m in (p + 1)..=q {
                    route_cells.push(cells[m]);
                }
            }
        }

        // Pin the requested endpoints when they sit on the main channel (the navigator
        // chose them), else the snapped cell center. Checking the main component, not just
        // navigability, matters when the requested point is in a disconnected pocket.
        let on_main = |p: Position| -> bool {
            let (c, r) = grid.cell_of(p);
            grid.is_navigable(c as i64, r as i64) && main_water[r * cols + c] == 1
        };
        let start_pos = if on_main(req.from) {
            req.from
        } else {
            grid.cell_center(route_cells[0])
        };
        let last_cell = route_cells[route_cells.len() - 1];
        let goal_pos = if on_main(req.to) {
            req.to
        } else {
            grid.cell_center(last_cell)
        };
        // Build the route positions in one pre-sized pass: the pinned endpoints, else each
        // cell center.
        let rc_len = route_cells.len();
        let mut route_positions: Vec<Position> = vec![req.from; rc_len];
        route_positions[0] = start_pos;
        route_positions[rc_len - 1] = goal_pos;
        for i in 1..rc_len - 1 {
            route_positions[i] = grid.cell_center(route_cells[i]);
        }
        // Decimate to TURNING points: drop each waypoint whose removal still leaves the
        // longer leg on water, so the dense cell-resolution trace becomes a handful of
        // turns. Endpoints are kept, and every surviving leg stays legSafe by construction.
        let waypoints = decimate_route(&route_positions, &leg_safe, req.deadline_ms);

        if !route_legs_on_water(&waypoints, &index, sample_spacing, clip_tolerance, req.deadline_ms) {
            return ChannelRouteResult::Decline {
                reason: ChannelDeclineReason::LandLeg,
            };
        }
        let used = used_tile_water(&waypoints, &index, contour, sample_spacing, req.deadline_ms);
        ChannelRouteResult::Ok {
            waypoints,
            used_tile_water: used,
            border_fallback: false,
        }
    };

    let foreign_block = if req.border_aware {
        provider.foreign_rings(bbox)
    } else {
        Vec::new()
    };
    let primary = attempt(&foreign_block);
    if matches!(primary, ChannelRouteResult::Ok { .. }) || foreign_block.is_empty() {
        return primary;
    }
    // The in-country attempt failed; fall back to the unconstrained route (reusing the
    // fetched data) so a route is still returned, flagged for the caller. Skip the retry
    // if too little budget remains, which only ever applies when a deadline is set.
    if let Some(d) = req.deadline_ms {
        if d - now_ms() < ROUTER_FALLBACK_MIN_MS {
            return primary;
        }
    }
    match attempt(&[]) {
        ChannelRouteResult::Ok {
            waypoints,
            used_tile_water,
            ..
        } => ChannelRouteResult::Ok {
            waypoints,
            used_tile_water,
            border_fallback: true,
        },
        decline => decline,
    }
}

/// Either both endpoints snapped onto a shared navigable component (with that
/// component), or a decline reason.
enum SnapResult {
    Snapped {
        start: (usize, usize),
        goal: (usize, usize),
        comp: Vec<u8>,
    },
    Decline(ChannelDeclineReason),
}

/// A mask of the 4-connected navigable cells reachable from `seed`.
fn component_from(grid: &NavGrid, seed: (usize, usize)) -> Vec<u8> {
    let cols = grid.cols();
    let rows = grid.rows();
    let mut mask = vec![0u8; cols * rows];
    let mut queue: Vec<usize> = Vec::with_capacity(cols * rows);
    let s = seed.1 * cols + seed.0;
    mask[s] = 1;
    queue.push(s);
    let mut head = 0;
    while head < queue.len() {
        let i = queue[head];
        head += 1;
        let r = i / cols;
        let c = i - r * cols;
        for &(dc, dr) in ORTHO_NEIGHBORS.iter() {
            let nc = c as i64 + dc;
            let nr = r as i64 + dr;
            if nc < 0 || nc >= cols as i64 || nr < 0 || nr >= rows as i64 {
                continue;
            }
            let ni = (nr as usize) * cols + nc as usize;
            if mask[ni] == 1 || !grid.is_navigable(nc, nr) {
                continue;
            }
            mask[ni] = 1;
            queue.push(ni);
        }
    }
    mask
}

/// A mask of the cells in the LARGEST 4-connected navigable component, the
/// through-channel. Seeds are enumerated in index order; a strict `>` keeps the lower
/// seed index on equal size, so the tie-break matches the reference.
fn largest_navigable_component(grid: &NavGrid) -> Vec<u8> {
    let cols = grid.cols();
    let rows = grid.rows();
    let n = cols * rows;
    let mut comp = vec![-1_i64; n];
    let mut queue: Vec<usize> = vec![0; n];
    let mut best_id = -1_i64;
    let mut best_size = 0usize;
    let mut next_id = 0_i64;
    for seed in 0..n {
        if comp[seed] != -1 {
            continue;
        }
        let sc = seed % cols;
        let sr = (seed - sc) / cols;
        if !grid.is_navigable(sc as i64, sr as i64) {
            continue;
        }
        let id = next_id;
        next_id += 1;
        let mut head = 0usize;
        let mut tail = 0usize;
        let mut size = 0usize;
        comp[seed] = id;
        queue[tail] = seed;
        tail += 1;
        while head < tail {
            let i = queue[head];
            head += 1;
            size += 1;
            let r = i / cols;
            let c = i - r * cols;
            for &(dc, dr) in ORTHO_NEIGHBORS.iter() {
                let nc = c as i64 + dc;
                let nr = r as i64 + dr;
                if nc < 0 || nc >= cols as i64 || nr < 0 || nr >= rows as i64 {
                    continue;
                }
                let ni = (nr as usize) * cols + nc as usize;
                if comp[ni] != -1 || !grid.is_navigable(nc, nr) {
                    continue;
                }
                comp[ni] = id;
                queue[tail] = ni;
                tail += 1;
            }
        }
        if size > best_size {
            best_size = size;
            best_id = id;
        }
    }
    let mut mask = vec![0u8; n];
    if best_id >= 0 {
        for i in 0..n {
            if comp[i] == best_id {
                mask[i] = 1;
            }
        }
    }
    mask
}

/// Snap both endpoints onto a SHARED navigable component so A* can connect them. Tries
/// the largest component first, then each endpoint's own nearest water with a re-snap
/// into the other's component, matching the reference fall-through order.
fn snap_endpoints(grid: &NavGrid, from: Position, to: Position, max_snap: f64) -> SnapResult {
    let cols = grid.cols();
    let largest = largest_navigable_component(grid);
    let start_main = snap_to_water(grid, from, max_snap, Some(&largest));
    let goal_main = snap_to_water(grid, to, max_snap, Some(&largest));
    if let (Some(start), Some(goal)) = (start_main, goal_main) {
        return SnapResult::Snapped {
            start,
            goal,
            comp: largest,
        };
    }

    let start_near = snap_to_water(grid, from, max_snap, None);
    let goal_near = snap_to_water(grid, to, max_snap, None);
    let (start_near, goal_near) = match (start_near, goal_near) {
        (Some(s), Some(g)) => (s, g),
        _ => return SnapResult::Decline(ChannelDeclineReason::Unsnappable),
    };
    let goal_comp = component_from(grid, goal_near);
    if goal_comp[cell_index(start_near, cols)] == 1 {
        return SnapResult::Snapped {
            start: start_near,
            goal: goal_near,
            comp: goal_comp,
        };
    }
    if let Some(start_in_goal) = snap_to_water(grid, from, max_snap, Some(&goal_comp)) {
        return SnapResult::Snapped {
            start: start_in_goal,
            goal: goal_near,
            comp: goal_comp,
        };
    }
    let start_comp = component_from(grid, start_near);
    if let Some(goal_in_start) = snap_to_water(grid, to, max_snap, Some(&start_comp)) {
        return SnapResult::Snapped {
            start: start_near,
            goal: goal_in_start,
            comp: start_comp,
        };
    }
    SnapResult::Decline(ChannelDeclineReason::NoPath)
}

/// Row-major index of a `(col, row)` cell.
fn cell_index(cell: (usize, usize), cols: usize) -> usize {
    cell.1 * cols + cell.0
}

/// The nearest navigable cell to a position within `max_snap_meters`, by an expanding
/// Chebyshev-ring search (dr outer, dc inner), accepting the first qualifying cell whose
/// true distance is within the cap and, when `in_component` is given, that is in that
/// component. Returns the position's own cell when it qualifies.
fn snap_to_water(
    grid: &NavGrid,
    p: Position,
    max_snap_meters: f64,
    in_component: Option<&[u8]>,
) -> Option<(usize, usize)> {
    let cols = grid.cols();
    let ok = |c: i64, r: i64| -> bool {
        grid.is_navigable(c, r)
            && match in_component {
                None => true,
                Some(comp) => comp[(r as usize) * cols + c as usize] == 1,
            }
    };
    let (c0, r0) = grid.cell_of(p);
    if ok(c0 as i64, r0 as i64) {
        return Some((c0, r0));
    }
    let cell_meters = grid.size().cell_meters;
    let max_radius = 1.0_f64.max((max_snap_meters / cell_meters).ceil()) as i64;
    // Test one ring cell at offset (dc, dr): accept it when it is in the component and
    // within the true distance cap.
    let try_cell = |dc: i64, dr: i64| -> Option<(usize, usize)> {
        let c = c0 as i64 + dc;
        let r = r0 as i64 + dr;
        if ok(c, r)
            && distance_meters(p, grid.cell_center((c as usize, r as usize))) <= max_snap_meters
        {
            Some((c as usize, r as usize))
        } else {
            None
        }
    };
    let mut radius = 1_i64;
    while radius <= max_radius {
        // Walk the Chebyshev ring perimeter in the exact order the full dr-outer, dc-inner
        // scan visited it: the top row left to right, then each interior row's left then
        // right side cell, then the bottom row left to right. Only the perimeter satisfies
        // `max(|dc|, |dr|) == radius`, so this emits the same cells in the same order while
        // skipping the interior the old scan iterated and discarded. The first qualifying
        // cell wins, so this order is part of the snap parity and must not change.
        for dc in -radius..=radius {
            if let Some(hit) = try_cell(dc, -radius) {
                return Some(hit);
            }
        }
        for dr in (-radius + 1)..=(radius - 1) {
            if let Some(hit) = try_cell(-radius, dr) {
                return Some(hit);
            }
            if let Some(hit) = try_cell(radius, dr) {
                return Some(hit);
            }
        }
        for dc in -radius..=radius {
            if let Some(hit) = try_cell(dc, radius) {
                return Some(hit);
            }
        }
        radius += 1;
    }
    None
}

/// A tile-water or ENC land polygon with its precomputed outer-extent bbox.
struct IndexedPoly {
    rings: Rings,
    bbox: Bbox,
}
/// An ENC depth-area polygon with its bbox and decoded `DRVAL1` (shallow_meters), None
/// when unknown.
struct IndexedDepth {
    rings: Rings,
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
struct WaterIndex {
    land: Vec<IndexedPoly>,
    depth: Vec<IndexedDepth>,
    tile: Vec<IndexedPoly>,
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
    if item_bboxes.is_empty() || !(lon_span > 0.0) || !(lat_span > 0.0) {
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
fn bucket_at<'a>(b: &'a SpatialBuckets, lon: f64, lat: f64) -> &'a [usize] {
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

fn build_water_index(bands: &[ChartedAreas], water: &TileWater) -> WaterIndex {
    // Read the per-band charted areas directly, in band order, so the index holds the
    // same polygons in the same order a flattened copy would, without the intermediate
    // clone of every area. Polygons whose bounds_of_rings produces a non-finite bbox
    // (empty rings, all-NaN vertices) are silently skipped rather than panicking in
    // union_bbox. All corpus polygons have finite vertices, so this filter never fires
    // on any corpus case.
    let land: Vec<IndexedPoly> = bands
        .iter()
        .flat_map(|b| b.land_areas.iter())
        .filter_map(|a| {
            let bbox = bounds_of_rings(&a.rings);
            if !bbox_is_finite(&bbox) {
                return None;
            }
            Some(IndexedPoly { rings: a.rings.clone(), bbox })
        })
        .collect();
    let depth: Vec<IndexedDepth> = bands
        .iter()
        .flat_map(|b| b.depth_areas.iter())
        .filter_map(|a| {
            let bbox = bounds_of_rings(&a.rings);
            if !bbox_is_finite(&bbox) {
                return None;
            }
            Some(IndexedDepth {
                rings: a.rings.clone(),
                bbox,
                shallow_meters: a.depth_range.as_ref().and_then(|d| d.shallow_meters),
            })
        })
        .collect();
    let tile: Vec<IndexedPoly> = water
        .water
        .iter()
        .filter_map(|w| {
            let bbox = bounds_of_rings(&w.rings);
            if !bbox_is_finite(&bbox) {
                return None;
            }
            Some(IndexedPoly { rings: w.rings.clone(), bbox })
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
fn point_in_indexed_land(poly: &IndexedPoly, lon: f64, lat: f64) -> bool {
    bbox_contains_point(&poly.bbox, lon, lat) && point_in_rings(lon, lat, &poly.rings)
}
fn point_in_indexed_depth(poly: &IndexedDepth, lon: f64, lat: f64) -> bool {
    bbox_contains_point(&poly.bbox, lon, lat) && point_in_rings(lon, lat, &poly.rings)
}

/// True when a point is inside an ENC depth area charted deep enough (defined
/// `DRVAL1 >= contour`).
fn in_enc_deep(lon: f64, lat: f64, index: &WaterIndex, contour: f64) -> bool {
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
fn navigable_at(lon: f64, lat: f64, index: &WaterIndex) -> bool {
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

/// True when the straight leg between two positions stays on navigable GRID cells. The
/// router's INTERNAL leg check for the repair and decimate passes, O(cells crossed).
fn leg_on_grid(grid: &NavGrid, a: Position, b: Position, sample_spacing_meters: f64) -> bool {
    let spacing = sample_spacing_meters.max(1.0);
    let on_cell = |p: Position| -> bool {
        let (c, r) = grid.cell_of(p);
        grid.is_navigable(c as i64, r as i64)
    };
    if !on_cell(a) {
        return false;
    }
    for s in sample_rhumb_leg(a, b, spacing) {
        if !on_cell(s) {
            return false;
        }
    }
    on_cell(b)
}

/// True when a single final leg stays on navigable water. It fails only when the leg runs
/// OFF water for a CONTINUOUS stretch longer than `tolerance_meters`; a shorter off-water
/// run is a sub-cell clip below the grid's resolution and is tolerated. The off-water run
/// counter resets on any on-water sample, and both endpoints are tested explicitly.
fn leg_stays_on_water(
    a: Position,
    b: Position,
    index: &WaterIndex,
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

/// Greedily drop interior waypoints to the minimal set of turning points: a waypoint is
/// removed when the longer leg that skips it still stays on water (`leg_safe`). The two
/// endpoints are always kept. One forward pass.
fn decimate_route<F: Fn(Position, Position) -> bool>(
    waypoints: &[Position],
    leg_safe: F,
    deadline_ms: Option<f64>,
) -> Vec<Position> {
    if waypoints.len() <= 2 {
        return waypoints.to_vec();
    }
    let last = waypoints.len() - 1;
    let mut kept: Vec<Position> = vec![waypoints[0]];
    let mut anchor = 0usize;
    let mut j = 1usize;
    while j < last {
        // Stop decimating once the deadline passes, keeping the rest of the trace; the
        // re-check that follows sees the deadline and declines cleanly.
        if over_deadline(deadline_ms) {
            for k in j..last {
                kept.push(waypoints[k]);
            }
            kept.push(waypoints[last]);
            return kept;
        }
        if leg_safe(waypoints[anchor], waypoints[j + 1]) {
            j += 1;
            continue;
        }
        kept.push(waypoints[j]);
        anchor = j;
        j += 1;
    }
    kept.push(waypoints[last]);
    kept
}

/// True when no final leg leaves navigable water. The router's honesty backstop at full
/// polygon resolution over a prebuilt index.
fn route_legs_on_water(
    waypoints: &[Position],
    index: &WaterIndex,
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
fn used_tile_water(
    waypoints: &[Position],
    index: &WaterIndex,
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
        let index = build_water_index(&[areas], &water);
        assert!(index.land.is_empty());
    }
}
