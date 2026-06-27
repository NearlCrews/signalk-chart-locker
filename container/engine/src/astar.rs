//! Grid A*, ported from `astar.ts`. The binary min-heap tie-break, the neighbor
//! expansion order, the diagonal anti-cornering rule, and the `hypot` heuristic
//! must match the TypeScript exactly, so the heap is hand-ported rather than built
//! on `std::collections::BinaryHeap`.

use crate::clock::over_deadline;

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

/// A tiny binary min-heap keyed by an `f64` priority; the payload is the cell index.
/// Hand-ported from the TypeScript `MinHeap`: the push sift-up breaks while the
/// parent key is `<=` the child (so an equal-key insert stops at the first equal
/// parent), and the pop sift-down picks the smaller child with a strict `<`. This
/// exact tie-break decides the order equal-f cells leave the heap, so it is
/// reproduced rather than delegated to `std::collections::BinaryHeap`.
struct MinHeap {
    keys: Vec<f64>,
    vals: Vec<usize>,
}

impl MinHeap {
    fn new() -> Self {
        MinHeap {
            keys: Vec::new(),
            vals: Vec::new(),
        }
    }

    fn size(&self) -> usize {
        self.keys.len()
    }

    fn push(&mut self, key: f64, val: usize) {
        self.keys.push(key);
        self.vals.push(val);
        let mut i = self.keys.len() - 1;
        while i > 0 {
            let p = (i - 1) >> 1;
            if self.keys[p] <= self.keys[i] {
                break;
            }
            self.swap(i, p);
            i = p;
        }
    }

    fn pop(&mut self) -> usize {
        let top = self.vals[0];
        let last_key = self.keys.pop().unwrap();
        let last_val = self.vals.pop().unwrap();
        if !self.keys.is_empty() {
            self.keys[0] = last_key;
            self.vals[0] = last_val;
            let mut i = 0;
            loop {
                let l = i * 2 + 1;
                let r = l + 1;
                let mut s = i;
                if l < self.keys.len() && self.keys[l] < self.keys[s] {
                    s = l;
                }
                if r < self.keys.len() && self.keys[r] < self.keys[s] {
                    s = r;
                }
                if s == i {
                    break;
                }
                self.swap(i, s);
                i = s;
            }
        }
        top
    }

    fn swap(&mut self, a: usize, b: usize) {
        self.keys.swap(a, b);
        self.vals.swap(a, b);
    }
}

const SQRT2: f64 = std::f64::consts::SQRT_2;

/// Neighbor offsets `(dc, dr, step)`: east, west, south, north, then the four
/// diagonals. The expansion order is part of the tie-break and must not change.
const NEIGHBORS: [(i64, i64, f64); 8] = [
    (1, 0, 1.0),
    (-1, 0, 1.0),
    (0, 1, 1.0),
    (0, -1, 1.0),
    (1, 1, SQRT2),
    (1, -1, SQRT2),
    (-1, 1, SQRT2),
    (-1, -1, SQRT2),
];

/// Check the wall-clock deadline every this many pops, to bound the synchronous search.
const DEADLINE_CHECK_INTERVAL: u64 = 4096;

/// 8-connected A* from `start` to `goal`, returning the ordered cell path including
/// both endpoints, or `None` when the goal is unreachable, an endpoint is not
/// navigable, or the deadline passes mid-search. Step cost is the geometric distance
/// times `1 + step_penalty(target)`; the Euclidean-distance heuristic stays
/// admissible because the penalty is non-negative. A diagonal step is disallowed
/// when it would cut between two blocked orthogonal neighbors, so the path never
/// clips a land corner. When `status` is given, its `timed_out` is set true only for
/// the deadline case, so a caller can tell a timeout apart from a true no-path.
pub fn find_path(
    grid: &dyn AStarGrid,
    start: (usize, usize),
    goal: (usize, usize),
    deadline_ms: Option<f64>,
    status: Option<&mut PathStatus>,
) -> Option<Vec<(usize, usize)>> {
    let cols = grid.cols();
    let rows = grid.rows();
    if !grid.is_navigable(start.0 as i64, start.1 as i64)
        || !grid.is_navigable(goal.0 as i64, goal.1 as i64)
    {
        return None;
    }
    let idx = |c: usize, r: usize| r * cols + c;
    let mut g_score = vec![f64::INFINITY; cols * rows];
    let mut came_from = vec![-1_i64; cols * rows];
    let mut closed = vec![0_u8; cols * rows];
    let goal_idx = idx(goal.0, goal.1);
    let goal_c = goal.0 as f64;
    let goal_r = goal.1 as f64;
    let h = |c: f64, r: f64| (c - goal_c).hypot(r - goal_r);
    let mut open = MinHeap::new();
    let start_idx = idx(start.0, start.1);
    g_score[start_idx] = 0.0;
    open.push(h(start.0 as f64, start.1 as f64), start_idx);
    let mut pops: u64 = 0;
    while open.size() > 0 {
        let cur = open.pop();
        if closed[cur] == 1 {
            continue;
        }
        closed[cur] = 1;
        if cur == goal_idx {
            break;
        }
        pops += 1;
        if pops % DEADLINE_CHECK_INTERVAL == 0 && over_deadline(deadline_ms) {
            if let Some(s) = status {
                s.timed_out = true;
            }
            return None;
        }
        let cr = cur / cols;
        let cc = cur - cr * cols;
        let base_g = g_score[cur];
        for &(dc, dr, step) in NEIGHBORS.iter() {
            let nc = cc as i64 + dc;
            let nr = cr as i64 + dr;
            if nc < 0 || nc >= cols as i64 || nr < 0 || nr >= rows as i64 {
                continue;
            }
            if !grid.is_navigable(nc, nr) {
                continue;
            }
            if dc != 0
                && dr != 0
                && (!grid.is_navigable(cc as i64 + dc, cr as i64)
                    || !grid.is_navigable(cc as i64, cr as i64 + dr))
            {
                continue;
            }
            let ni = idx(nc as usize, nr as usize);
            if closed[ni] == 1 {
                continue;
            }
            let tentative = base_g + step * (1.0 + grid.step_penalty(nc, nr));
            if tentative < g_score[ni] {
                g_score[ni] = tentative;
                came_from[ni] = cur as i64;
                open.push(tentative + h(nc as f64, nr as f64), ni);
            }
        }
    }
    if g_score[goal_idx] == f64::INFINITY {
        return None;
    }
    let mut path: Vec<(usize, usize)> = Vec::new();
    let mut i = goal_idx as i64;
    while i != -1 {
        let iu = i as usize;
        path.push((iu % cols, iu / cols));
        i = came_from[iu];
    }
    path.reverse();
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grid from rows of '.' (navigable) and '#' (blocked).
    struct StrGrid {
        rows: Vec<Vec<u8>>,
        cols: usize,
    }

    impl StrGrid {
        fn new(rows: &[&str]) -> Self {
            let rows: Vec<Vec<u8>> = rows.iter().map(|r| r.bytes().collect()).collect();
            let cols = rows[0].len();
            StrGrid { rows, cols }
        }
    }

    impl AStarGrid for StrGrid {
        fn cols(&self) -> usize {
            self.cols
        }
        fn rows(&self) -> usize {
            self.rows.len()
        }
        fn is_navigable(&self, col: i64, row: i64) -> bool {
            row >= 0
                && (row as usize) < self.rows.len()
                && col >= 0
                && (col as usize) < self.cols
                && self.rows[row as usize][col as usize] == b'.'
        }
        fn step_penalty(&self, _col: i64, _row: i64) -> f64 {
            0.0
        }
    }

    /// A fully open grid whose row 0 carries a heavy step penalty.
    struct PenaltyGrid;
    impl AStarGrid for PenaltyGrid {
        fn cols(&self) -> usize {
            5
        }
        fn rows(&self) -> usize {
            3
        }
        fn is_navigable(&self, col: i64, row: i64) -> bool {
            col >= 0 && col < 5 && row >= 0 && row < 3
        }
        fn step_penalty(&self, _col: i64, row: i64) -> f64 {
            if row == 0 {
                10.0
            } else {
                0.0
            }
        }
    }

    fn run(grid: &dyn AStarGrid, start: (usize, usize), goal: (usize, usize)) -> Option<Vec<(usize, usize)>> {
        find_path(grid, start, goal, None, None)
    }

    /// Each step is to an adjacent (within one cell) navigable cell.
    fn assert_contiguous(path: &[(usize, usize)], g: &dyn AStarGrid) {
        for &(c, r) in path {
            assert!(g.is_navigable(c as i64, r as i64), "step {},{} is navigable", c, r);
        }
        for i in 1..path.len() {
            let dc = (path[i].0 as i64 - path[i - 1].0 as i64).abs();
            let dr = (path[i].1 as i64 - path[i - 1].1 as i64).abs();
            assert!(dc <= 1 && dr <= 1, "steps are adjacent");
        }
    }

    #[test]
    fn crosses_open_water() {
        let g = StrGrid::new(&[".....", ".....", "....."]);
        let path = run(&g, (0, 1), (4, 1)).expect("path exists");
        assert!(path.len() >= 2);
        assert_eq!(path[0], (0, 1));
        assert_eq!(path[path.len() - 1], (4, 1));
        assert_contiguous(&path, &g);
    }

    #[test]
    fn routes_around_a_wall() {
        let g = StrGrid::new(&[".....", ".###.", "....."]);
        let path = run(&g, (0, 1), (4, 1)).expect("path exists");
        assert_contiguous(&path, &g);
    }

    #[test]
    fn returns_none_when_blocked_off() {
        let g = StrGrid::new(&["..#..", "..#..", "..#.."]);
        assert_eq!(run(&g, (0, 1), (4, 1)), None);
    }

    #[test]
    fn does_not_cut_a_diagonal_between_two_blocked_orthogonal_cells() {
        // The only diagonal step from (0,0) to (1,1) would slip between the two '#'.
        let g = StrGrid::new(&[".#", "#."]);
        assert_eq!(run(&g, (0, 0), (1, 1)), None);
    }

    #[test]
    fn returns_the_single_cell_when_start_equals_goal() {
        let g = StrGrid::new(&["..."]);
        assert_eq!(run(&g, (1, 0), (1, 0)), Some(vec![(1, 0)]));
    }

    #[test]
    fn returns_none_when_the_start_is_blocked() {
        let g = StrGrid::new(&["#.."]);
        assert_eq!(run(&g, (0, 0), (2, 0)), None);
    }

    #[test]
    fn dips_out_of_a_high_penalty_row_when_a_cheaper_lane_exists() {
        // Fully open 5x3 grid; row 0 carries a heavy step penalty. The straight
        // (0,0)->(4,0) run stays in row 0 absent the penalty, so a penalty-aware A*
        // must dip its interior into the cheaper rows below.
        let g = PenaltyGrid;
        let path = run(&g, (0, 0), (4, 0)).expect("path exists");
        let interior = &path[1..path.len() - 1];
        assert!(
            interior.iter().any(|&(_, r)| r >= 1),
            "the interior leaves the penalized row 0"
        );
    }
}
