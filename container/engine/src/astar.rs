//! Grid A*, ported from `astar.ts`. The binary min-heap tie-break, the neighbor
//! expansion order, the diagonal anti-cornering rule, and the `hypot` heuristic
//! must match the TypeScript exactly, so the heap is hand-ported rather than built
//! on `std::collections::BinaryHeap`.

/// The grid A* operates over; coordinates are `(col, row)`, origin top-left.
/// Out-of-bounds coordinates are not navigable, so the methods take signed inputs.
pub trait AStarGrid {
    fn cols(&self) -> usize;
    fn rows(&self) -> usize;
    /// True when `(col, row)` is in bounds and navigable.
    fn is_navigable(&self, col: i64, row: i64) -> bool;
    /// Non-negative extra cost for stepping into `(col, row)`, the standoff cost.
    fn step_penalty(&self, col: i64, row: i64) -> f64;
}

/// Set when `find_path` returns `None` because the deadline passed mid-search, so a
/// caller can tell a timeout apart from a true no-path.
#[derive(Debug, Default, Clone, Copy)]
pub struct PathStatus {
    pub timed_out: bool,
}

/// 8-connected A* from `start` to `goal`, returning the ordered cell path including
/// both endpoints, or `None` when the goal is unreachable, an endpoint is not
/// navigable, or the deadline passes mid-search.
pub fn find_path(
    grid: &dyn AStarGrid,
    start: (usize, usize),
    goal: (usize, usize),
    deadline_ms: Option<f64>,
    status: Option<&mut PathStatus>,
) -> Option<Vec<(usize, usize)>> {
    todo!("port findPath and the MinHeap from astar.ts, preserving the tie-break and neighbor order")
}
