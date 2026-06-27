//! Endpoint snapping: find a shared navigable component for both endpoints so A* can
//! connect them. Split out of channel_router.rs; the orchestrator calls only
//! snap_endpoints and matches on SnapResult.

use crate::astar::AStarGrid;
use crate::geometry::distance_meters;
use crate::nav_grid::{NavGrid, ORTHO_NEIGHBORS};
use crate::types::{ChannelDeclineReason, Position};

/// Either both endpoints snapped onto a shared navigable component (with that
/// component), or a decline reason.
pub(crate) enum SnapResult {
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
        for &(dc, dr) in &ORTHO_NEIGHBORS {
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
            for &(dc, dr) in &ORTHO_NEIGHBORS {
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
pub(crate) fn snap_endpoints(grid: &NavGrid, from: Position, to: Position, max_snap: f64) -> SnapResult {
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
