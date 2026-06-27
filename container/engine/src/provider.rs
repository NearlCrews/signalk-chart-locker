//! The replay `FileProvider`: serves the captured corpus provider calls keyed by the
//! query inputs, so the Rust engine and the TypeScript reference see identical provider
//! responses. A captured `calls.json` records every charted-areas, tile-water, and
//! foreign-rings call the reference run made, each with the exact bbox the router passed
//! and the result the provider returned (or null when that fetch rejected).

use serde::Deserialize;

use crate::types::{Bbox, ChartedAreas, Provider, RingPolygon, ScaleBand, TileWater};

/// Largest per-component ulp gap allowed between the engine's queried bbox and the bbox
/// the reference captured. The two agree exactly on most inputs, but `route_bbox`'s
/// projection transcendentals can differ by one or two ulp between the V8 and the Rust
/// math libraries, so a tiny gap is expected. A larger gap means a real `route_bbox`
/// divergence, which this guard surfaces directly instead of leaving it to show up as an
/// opaque waypoint mismatch.
const MAX_BBOX_ULP_GAP: i64 = 2;

/// One captured charted-areas call: the band and bbox the router queried, and the result
/// it returned, or `None` when that band's fetch rejected.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartedAreasCall {
    band: ScaleBand,
    bbox: Bbox,
    result: Option<ChartedAreas>,
}

/// The captured tile-water call: the bbox queried and the result, or `None` when every
/// tile failed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TileWaterCall {
    bbox: Bbox,
    result: Option<TileWater>,
}

/// The captured foreign-rings call: the bbox queried and the foreign water rings the
/// reference returned.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeignRingsCall {
    bbox: Bbox,
    result: Vec<RingPolygon>,
}

/// A captured `calls.json`. A top-level `null` for `tile_water` or `foreign_rings` means
/// the router never made that call.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallsFile {
    charted_areas: Vec<ChartedAreasCall>,
    #[serde(default)]
    tile_water: Option<TileWaterCall>,
    #[serde(default)]
    foreign_rings: Option<ForeignRingsCall>,
}

/// The ulp gap between two finite floats, as a non-negative count. Both are mapped to the
/// monotonic sign-magnitude ordering first, so the subtraction counts representable
/// steps correctly across zero and sign.
pub(crate) fn ulp_gap(a: f64, b: f64) -> i64 {
    let order = |x: f64| -> i64 {
        let bits = x.to_bits() as i64;
        if bits < 0 {
            i64::MIN - bits
        } else {
            bits
        }
    };
    (order(a) - order(b)).abs()
}

/// Assert the engine's queried bbox matches the captured bbox within the ulp tolerance.
/// A failure means `route_bbox` diverged from the reference by more than rounding, which
/// is a real bug; panicking here names the offending component instead of letting it
/// surface later as an unexplained waypoint mismatch.
fn assert_bbox_close(call: &str, engine: Bbox, captured: Bbox) {
    for (name, a, b) in [
        ("north", engine.north, captured.north),
        ("south", engine.south, captured.south),
        ("east", engine.east, captured.east),
        ("west", engine.west, captured.west),
    ] {
        let gap = ulp_gap(a, b);
        assert!(
            gap <= MAX_BBOX_ULP_GAP,
            "{call} bbox {name} differs by {gap} ulp: engine {a}, captured {b}",
        );
    }
}

/// Replays provider responses captured from the TypeScript reference. Each corpus case
/// queries every band once and makes at most one tile-water and one foreign-rings call,
/// so the band is the unique key for charted areas and the single captured call answers
/// the others.
///
/// Lookups key on the band rather than the exact `(band, bbox)`: the engine's `route_bbox`
/// is bit-reproducible against the reference for many inputs but not all (the projection's
/// transcendentals can differ by one or two ulp between the V8 and the Rust math
/// libraries), so keying on the exact bbox would spuriously miss the data on those inputs
/// even though the captured response is exactly what the reference returned. The captured
/// bbox is still checked against the engine's, within a small ulp tolerance, so a genuine
/// `route_bbox` divergence is caught directly rather than only through a waypoint mismatch.
pub struct FileProvider {
    charted: Vec<ChartedAreasCall>,
    tile: Option<TileWaterCall>,
    foreign: Option<ForeignRingsCall>,
}

impl FileProvider {
    /// Load a captured corpus case from its `calls.json` contents.
    pub fn from_calls_json(json: &str) -> serde_json::Result<Self> {
        let calls: CallsFile = serde_json::from_str(json)?;
        Ok(FileProvider {
            charted: calls.charted_areas,
            tile: calls.tile_water,
            foreign: calls.foreign_rings,
        })
    }

    /// The bands present in the captured calls, in the order the router queried them.
    pub fn bands(&self) -> Vec<ScaleBand> {
        self.charted.iter().map(|c| c.band).collect()
    }
}

impl Provider for FileProvider {
    fn charted_areas(&self, band: ScaleBand, bbox: Bbox) -> Option<ChartedAreas> {
        let call = self.charted.iter().find(|c| c.band == band)?;
        assert_bbox_close("chartedAreas", bbox, call.bbox);
        call.result.clone()
    }

    fn tile_water(&self, bbox: Bbox) -> Option<TileWater> {
        let call = self.tile.as_ref()?;
        assert_bbox_close("tileWater", bbox, call.bbox);
        call.result.clone()
    }

    fn foreign_rings(&self, bbox: Bbox) -> Vec<RingPolygon> {
        match self.foreign.as_ref() {
            Some(call) => {
                assert_bbox_close("foreignRings", bbox, call.bbox);
                call.result.clone()
            }
            None => Vec::new(),
        }
    }
}
