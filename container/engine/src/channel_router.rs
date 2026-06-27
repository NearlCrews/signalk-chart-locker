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
use crate::geometry::{route_bbox, sample_rhumb_leg, METERS_PER_NAUTICAL_MILE};
use crate::nav_grid::{build_nav_grid, resolve_grid_size, NavGrid, NavGridParams};
use crate::path_simplify::simplify_path;
use crate::snap::{snap_endpoints, SnapResult};
use crate::types::{
    ChannelDeclineReason, ChannelRouteRequest, ChannelRouteResult, ChartedAreas, Position,
    Provider, RingPolygon, ScaleBand, TileWater,
};
use crate::water_index::{build_water_index, route_legs_on_water, used_tile_water};

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
        && anchors.iter().all(&coord_finite)
        && req.corridor.as_deref().unwrap_or(&[]).iter().all(coord_finite);
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
                route_cells.extend_from_slice(&cells[(p + 1)..=q]);
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
        // cell center. Pushing in order avoids the prior fill-then-overwrite of every slot.
        let rc_len = route_cells.len();
        let mut route_positions: Vec<Position> = Vec::with_capacity(rc_len);
        for (i, cell) in route_cells.iter().enumerate() {
            // Last index wins, mirroring the prior writes: the goal pins the final slot
            // (which also covers a single-cell route), the start pins slot 0, and every
            // interior slot takes its cell center.
            let p = if i == rc_len - 1 {
                goal_pos
            } else if i == 0 {
                start_pos
            } else {
                grid.cell_center(*cell)
            };
            route_positions.push(p);
        }
        // Decimate to TURNING points: drop each waypoint whose removal still leaves the
        // longer leg on water, so the dense cell-resolution trace becomes a handful of
        // turns. Endpoints are kept, and every surviving leg stays legSafe by construction.
        let waypoints = decimate_route(&route_positions, leg_safe, req.deadline_ms);

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
            kept.extend_from_slice(&waypoints[j..last]);
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
