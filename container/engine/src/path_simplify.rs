//! Ramer-Douglas-Peucker reduction, ported from `path-simplify.ts`. Points are
//! `[x, y]` in planar units (grid cells). The lowest-index maximum-deviation point
//! is the split point (strict `>`), and the endpoints are always kept.

/// Reduce a dense polyline to its turning points, keeping any interior point whose
/// perpendicular deviation from its chord exceeds `epsilon`.
pub fn simplify_path(points: &[[f64; 2]], epsilon: f64) -> Vec<[f64; 2]> {
    todo!("port simplifyPath from path-simplify.ts, preserving the lowest-index split tie-break")
}
