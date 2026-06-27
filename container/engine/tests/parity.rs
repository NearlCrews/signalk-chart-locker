//! The Milestone 2 proof gate: for every case in the replay corpus, run the Rust
//! `route_channel` against the captured provider calls and assert the result agrees with
//! the TypeScript reference. Waypoint coordinates are compared within a small ULP
//! tolerance (design spec section 8) so platform libm differences between aarch64 and
//! amd64 do not produce false failures. `usedTileWater`, `borderFallback`, and the
//! decline reason are exact (boolean and enum, no floating-point involved).

use std::fs;
use std::path::{Path, PathBuf};

use binnacle_engine::provider::FileProvider;
use binnacle_engine::{route_channel, ChannelRouteRequest, ChannelRouteResult, Position};
use serde::Deserialize;

/// The corpus INDEX.json: the ordered list of case directory names.
#[derive(Deserialize)]
struct Index {
    cases: Vec<String>,
}

/// The captured `result.json` flags, a view of the TypeScript `ChannelRouteResult`
/// minus the waypoints. `borderFallback` defaults false when absent, matching the
/// reference shape. The waypoint coordinates are parsed separately (see
/// `extract_waypoints`) because serde_json's default float parser is not correctly
/// rounded.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    ok: bool,
    #[serde(default)]
    used_tile_water: bool,
    #[serde(default)]
    border_fallback: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// Read the number token that follows `"<key>":` in `s`, parsing it with Rust std's
/// `str::parse`, which is correctly rounded.
fn number_after(s: &str, key: &str) -> f64 {
    let at = s.find(key).unwrap_or_else(|| panic!("missing key {key}"));
    let colon = s[at..].find(':').unwrap_or_else(|| panic!("missing ':' after key {key}")) + at + 1;
    s[colon..]
        .trim_start()
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != ',' && *c != '}' && *c != ']')
        .collect::<String>()
        .parse()
        .unwrap_or_else(|_| panic!("parse number for {key}"))
}

/// Extract the oracle waypoint coordinates from the raw `result.json` text, parsing each
/// latitude and longitude with std's correctly-rounded float parser rather than
/// serde_json's default parser. serde_json's default parser shifts some of the 17-digit
/// oracle values by one ulp (for example it reads `0.22056046680800134` as the next f64
/// up), which would be a false mismatch against the engine's correctly computed value.
/// The waypoints array holds flat `{ latitude, longitude }` objects with no nested
/// arrays, so the first `]` after the array's `[` closes it.
fn extract_waypoints(raw: &str) -> Vec<Position> {
    let key = match raw.find("\"waypoints\"") {
        Some(i) => i,
        None => return Vec::new(),
    };
    let open = key + raw[key..].find('[').expect("waypoints array has no opening bracket");
    let close = open + raw[open..].find(']').expect("waypoints array has no closing bracket");
    let interior = &raw[open + 1..close];
    let mut out = Vec::new();
    for piece in interior.split('}') {
        if piece.contains("\"latitude\"") {
            out.push(Position {
                latitude: number_after(piece, "\"latitude\""),
                longitude: number_after(piece, "\"longitude\""),
            });
        }
    }
    out
}

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Per-coordinate ULP tolerance for waypoint comparisons; see design spec section 8.
/// Matches `MAX_BBOX_ULP_GAP` in `provider.rs`: both stem from the same platform libm
/// bound between V8 and the Rust math libraries.
const MAX_WAYPOINT_ULP_GAP: i64 = 2;

/// ULP gap between two finite f64 values, non-negative. Maps both to the monotonic
/// sign-magnitude ordering so the count is correct across zero and sign changes.
fn ulp_gap(a: f64, b: f64) -> i64 {
    let order = |x: f64| -> i64 {
        let bits = x.to_bits() as i64;
        if bits < 0 { i64::MIN - bits } else { bits }
    };
    (order(a) - order(b)).abs()
}

/// Compare the Rust result against the captured TypeScript result. Returns `Ok` when
/// coordinates are within `MAX_WAYPOINT_ULP_GAP`, booleans and the decline reason are
/// exact, or `Err` with a one-line description of the first divergence.
fn check(
    case: &str,
    actual: &ChannelRouteResult,
    expected: &Expected,
    expected_waypoints: &[Position],
) -> Result<(), String> {
    if expected.ok {
        match actual {
            ChannelRouteResult::Ok {
                waypoints,
                used_tile_water,
                border_fallback,
            } => {
                if waypoints.len() != expected_waypoints.len() {
                    return Err(format!(
                        "{case}: waypoint count {} != expected {}",
                        waypoints.len(),
                        expected_waypoints.len()
                    ));
                }
                for (i, (a, e)) in waypoints.iter().zip(expected_waypoints.iter()).enumerate() {
                    let lat_gap = ulp_gap(a.latitude, e.latitude);
                    let lon_gap = ulp_gap(a.longitude, e.longitude);
                    if lat_gap > MAX_WAYPOINT_ULP_GAP || lon_gap > MAX_WAYPOINT_ULP_GAP {
                        return Err(format!(
                            "{case}: waypoint {i} ({}, {}) differs from expected ({}, {}) \
                             by ({lat_gap}, {lon_gap}) ulp",
                            a.latitude, a.longitude, e.latitude, e.longitude
                        ));
                    }
                }
                if *used_tile_water != expected.used_tile_water {
                    return Err(format!(
                        "{case}: usedTileWater {used_tile_water} != expected {}",
                        expected.used_tile_water
                    ));
                }
                if *border_fallback != expected.border_fallback {
                    return Err(format!(
                        "{case}: borderFallback {border_fallback} != expected {}",
                        expected.border_fallback
                    ));
                }
                Ok(())
            }
            ChannelRouteResult::Decline { reason } => Err(format!(
                "{case}: expected ok with {} waypoints, got decline {reason:?}",
                expected_waypoints.len()
            )),
        }
    } else {
        match actual {
            ChannelRouteResult::Decline { reason } => {
                let got = serde_json::to_value(reason).unwrap();
                let want = serde_json::Value::String(expected.reason.clone().unwrap_or_default());
                if got != want {
                    return Err(format!("{case}: decline reason {got} != expected {want}"));
                }
                Ok(())
            }
            ChannelRouteResult::Ok { waypoints, .. } => Err(format!(
                "{case}: expected decline {:?}, got ok with {} waypoints",
                expected.reason,
                waypoints.len()
            )),
        }
    }
}

#[test]
fn parity_over_the_whole_corpus() {
    let dir = corpus_dir();
    let index: Index =
        serde_json::from_str(&read(&dir.join("INDEX.json"))).expect("parse INDEX.json");

    let mut failures: Vec<String> = Vec::new();
    let mut passed = 0usize;
    for case in &index.cases {
        let cdir = dir.join(case);
        let req: ChannelRouteRequest =
            serde_json::from_str(&read(&cdir.join("request.json"))).expect("parse request.json");
        let provider = FileProvider::from_calls_json(&read(&cdir.join("calls.json")))
            .expect("parse calls.json");
        let result_raw = read(&cdir.join("result.json"));
        let expected: Expected =
            serde_json::from_str(&result_raw).expect("parse result.json");
        let expected_waypoints = extract_waypoints(&result_raw);

        let bands = provider.bands();
        let actual = route_channel(&provider, &bands, &req);
        match check(case, &actual, &expected, &expected_waypoints) {
            Ok(()) => {
                passed += 1;
                println!("PASS {case}");
            }
            Err(msg) => {
                println!("FAIL {msg}");
                failures.push(msg);
            }
        }
    }

    println!("parity: {passed}/{} cases pass", index.cases.len());
    assert!(
        failures.is_empty(),
        "parity failures ({}/{}):\n{}",
        failures.len(),
        index.cases.len(),
        failures.join("\n")
    );
}

/// Verify that the ULP tolerance boundary behaves correctly: waypoints within
/// `MAX_WAYPOINT_ULP_GAP` pass, and those beyond it fail.
#[test]
fn waypoint_ulp_tolerance_boundary() {
    use binnacle_engine::Position;

    let base = Position {
        latitude: 47.61071647312815,
        longitude: -122.37857510526305,
    };

    // A waypoint that is bit-identical passes.
    assert_eq!(ulp_gap(base.latitude, base.latitude), 0);
    assert_eq!(ulp_gap(base.longitude, base.longitude), 0);

    // A waypoint shifted by 1 ULP passes.
    let lat_plus_1 = f64::from_bits(base.latitude.to_bits() + 1);
    let lon_plus_1 = f64::from_bits(base.longitude.to_bits() + 1);
    assert_eq!(ulp_gap(base.latitude, lat_plus_1), 1);
    assert_eq!(ulp_gap(base.longitude, lon_plus_1), 1);
    assert!(ulp_gap(base.latitude, lat_plus_1) <= MAX_WAYPOINT_ULP_GAP);
    assert!(ulp_gap(base.longitude, lon_plus_1) <= MAX_WAYPOINT_ULP_GAP);

    // A waypoint shifted by 2 ULP (the boundary) passes.
    let lat_plus_2 = f64::from_bits(base.latitude.to_bits() + 2);
    assert_eq!(ulp_gap(base.latitude, lat_plus_2), 2);
    assert!(ulp_gap(base.latitude, lat_plus_2) <= MAX_WAYPOINT_ULP_GAP);

    // A waypoint shifted by 100 ULP is clearly beyond the tolerance and must fail.
    let lat_plus_100 = f64::from_bits(base.latitude.to_bits() + 100);
    assert_eq!(ulp_gap(base.latitude, lat_plus_100), 100);
    assert!(ulp_gap(base.latitude, lat_plus_100) > MAX_WAYPOINT_ULP_GAP);
}
