//! Ramer-Douglas-Peucker reduction, ported from `path-simplify.ts`. Points are
//! `[x, y]` in planar units (grid cells). The lowest-index maximum-deviation point
//! is the split point (strict `>`), and the endpoints are always kept.

/// Reduce a dense polyline to its turning points, keeping any interior point whose
/// perpendicular deviation from its chord exceeds `epsilon`.
pub fn simplify_path(points: &[[f64; 2]], epsilon: f64) -> Vec<[f64; 2]> {
    let n = points.len();
    if n < 3 {
        return points.iter().map(|p| [p[0], p[1]]).collect();
    }
    // Iterative Douglas-Peucker over an explicit stack of index ranges, marking the
    // points to keep, so a long winding path (the A* centerline can run to thousands
    // of cells) cannot overflow the call stack the way recursion would. The kept set
    // is the two endpoints plus every split point (the farthest interior point beyond
    // epsilon from its chord), collected in index order: identical to the recursion.
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack: Vec<(usize, usize)> = vec![(0, n - 1)];
    while let Some((lo, hi)) = stack.pop() {
        let ax = points[lo][0];
        let ay = points[lo][1];
        let bx = points[hi][0];
        let by = points[hi][1];
        let dx = bx - ax;
        let dy = by - ay;
        // `|| 1e-9` in the source guards a zero-length chord (a falsy hypot); a NaN
        // hypot is falsy in JavaScript too, so fall back on either.
        let len = {
            let h = dx.hypot(dy);
            if h == 0.0 || h.is_nan() {
                1e-9
            } else {
                h
            }
        };
        let mut far = 0.0_f64;
        let mut far_idx: Option<usize> = None;
        for (i, point) in points.iter().enumerate().take(hi).skip(lo + 1) {
            let px = point[0];
            let py = point[1];
            let dist = (dy * px - dx * py + bx * ay - by * ax).abs() / len;
            if dist > far {
                far = dist;
                far_idx = Some(i);
            }
        }
        if far > epsilon {
            if let Some(idx) = far_idx {
                keep[idx] = true;
                stack.push((lo, idx));
                stack.push((idx, hi));
            }
        }
    }
    let mut out: Vec<[f64; 2]> = Vec::new();
    for i in 0..n {
        if keep[i] {
            out.push([points[i][0], points[i][1]]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_a_straight_run_to_its_endpoints() {
        let line = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]];
        assert_eq!(simplify_path(&line, 0.5), vec![[0.0, 0.0], [3.0, 0.0]]);
    }

    #[test]
    fn keeps_a_corner_beyond_the_tolerance() {
        let line = [[0.0, 0.0], [5.0, 0.0], [5.0, 5.0]];
        assert_eq!(
            simplify_path(&line, 0.5),
            vec![[0.0, 0.0], [5.0, 0.0], [5.0, 5.0]]
        );
    }

    #[test]
    fn returns_short_inputs_unchanged() {
        assert_eq!(
            simplify_path(&[[0.0, 0.0], [1.0, 1.0]], 1.0),
            vec![[0.0, 0.0], [1.0, 1.0]]
        );
        assert_eq!(simplify_path(&[[0.0, 0.0]], 1.0), vec![[0.0, 0.0]]);
    }

    #[test]
    fn keeps_every_corner_of_a_zigzag_at_a_small_epsilon() {
        let zig = [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [4.0, 2.0], [4.0, 4.0]];
        assert_eq!(simplify_path(&zig, 0.5), zig.to_vec());
    }

    #[test]
    fn drops_a_point_just_under_epsilon_and_keeps_one_just_over() {
        // The middle point deviates 0.4 from the [0,0]->[10,0] line: under epsilon
        // 0.5, dropped.
        assert_eq!(
            simplify_path(&[[0.0, 0.0], [5.0, 0.4], [10.0, 0.0]], 0.5),
            vec![[0.0, 0.0], [10.0, 0.0]]
        );
        // 0.6 deviation: over epsilon, kept.
        assert_eq!(
            simplify_path(&[[0.0, 0.0], [5.0, 0.6], [10.0, 0.0]], 0.5),
            vec![[0.0, 0.0], [5.0, 0.6], [10.0, 0.0]]
        );
    }
}
