//! The Milestone 2 proof gate: for every case in the replay corpus, run the Rust
//! `route_channel` against the captured provider calls and assert the result equals the
//! TypeScript reference exactly. The bar is bit-for-bit on each waypoint latitude and
//! longitude, on `usedTileWater`, on `borderFallback`, and on the decline reason. With
//! no deadline the router is deterministic, so exact equality is the right bar: any
//! divergence is a finding to close, not a tolerance to widen.

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
    let colon = s[at..].find(':').unwrap() + at + 1;
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
    let open = key + raw[key..].find('[').unwrap();
    let close = open + raw[open..].find(']').unwrap();
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

/// Two f64 are equal for parity when their bit patterns match: the strictest test, so a
/// 1-ulp drift or a sign-of-zero difference is a failure, not a pass.
fn bits_eq(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits()
}

/// Compare the Rust result against the captured TypeScript result. Returns `Ok` on an
/// exact match, or `Err` with a one-line description of the first divergence.
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
                    if !bits_eq(a.latitude, e.latitude) || !bits_eq(a.longitude, e.longitude) {
                        return Err(format!(
                            "{case}: waypoint {i} ({}, {}) != expected ({}, {})",
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
