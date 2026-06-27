//! Synthetic deadline bail-out test: verifies that a request carrying a `deadline_ms`
//! already in the past causes `route_channel` to decline conservatively rather than
//! produce a route.
//!
//! The corpus runs with no deadline so the router is a pure function of its inputs and
//! the replay oracle is exact. This test covers the nondeterministic deadline path the
//! corpus deliberately omits.
//!
//! ## Where the first check fires
//!
//! `build_nav_grid` passes `deadline_ms` into `fill_polygon_cells`, which checks the
//! wall clock every 256 scanline rows. Row 0 of the first polygon always qualifies
//! (`(0 - r_start) & 255 == 0`), so with a past-epoch deadline the check fires on the
//! very first polygon row, `build_nav_grid` returns an empty (no-water) grid, and
//! `route_channel` maps that to a `NoCoverage` decline before A* is ever invoked.
//!
//! The `Deadline` variant (from A*'s 4096-pop check) is therefore not reachable via
//! `route_channel` with a static past-epoch timestamp and real polygon data: the grid
//! build stage fires first. The test below asserts the conservative decline the router
//! produces; the exact reason is `NoCoverage` (grid bail-out), not `Deadline` (A*
//! timeout). Both are conservative and correct.

use std::fs;
use std::path::{Path, PathBuf};

use binnacle_engine::provider::FileProvider;
use binnacle_engine::{route_channel, ChannelRouteRequest, ChannelRouteResult};

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// A request with `deadline_ms` already in the past must not produce a route.
///
/// This test loads `enc-l-channel`, a case whose `result.json` is `ok` (the router
/// finds a two-turn L-shaped path with no deadline), then overrides `deadline_ms` to
/// `Some(1.0)` -- one millisecond after the Unix epoch, permanently in the past. The
/// router must decline rather than route. The first deadline check fires in
/// `fill_polygon_cells` during `build_nav_grid` (row 0 of the first ENC depth-area
/// polygon), which returns an empty grid and causes a `NoCoverage` decline before A*
/// is reached.
#[test]
fn past_deadline_short_circuits_to_decline() {
    let cdir = corpus_dir().join("enc-l-channel");
    let mut req: ChannelRouteRequest =
        serde_json::from_str(&read(&cdir.join("request.json"))).expect("parse request.json");
    // One millisecond after the Unix epoch: always in the past.
    req.deadline_ms = Some(1.0);

    let provider =
        FileProvider::from_calls_json(&read(&cdir.join("calls.json"))).expect("parse calls.json");
    let bands = provider.bands();
    let result = route_channel(&provider, &bands, &req);

    // The router must not produce a route when the deadline is already past. The
    // first bail-out fires in the grid build (fill_polygon_cells, row 0 of the first
    // ENC polygon), which returns NoCoverage. Either way, the invariant is: a
    // past-epoch deadline yields a conservative Decline, never an Ok route.
    assert!(
        matches!(result, ChannelRouteResult::Decline { .. }),
        "expected a Decline with a past-epoch deadline but got an Ok route: {:?}",
        result
    );
}
