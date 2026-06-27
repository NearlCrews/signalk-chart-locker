//! The replay `FileProvider`: serves the captured corpus provider calls keyed by the
//! query inputs, so the Rust engine and the TypeScript reference see identical provider
//! responses. A captured `calls.json` records every charted-areas, tile-water, and
//! foreign-rings call the reference run made, each with the exact bbox the router passed
//! and the result the provider returned (or null when that fetch rejected).

use serde::Deserialize;

use crate::types::{Bbox, ChartedAreas, Provider, RingPolygon, ScaleBand, TileWater};

/// One captured charted-areas call: the band the router queried and the result it
/// returned, or `None` when that band's fetch rejected. The captured bbox is not modeled
/// here because the lookup keys on the band; see the `FileProvider` doc for why.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartedAreasCall {
    band: ScaleBand,
    result: Option<ChartedAreas>,
}

/// The captured tile-water call: the result, or `None` when every tile failed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TileWaterCall {
    result: Option<TileWater>,
}

/// The captured foreign-rings call: the foreign water rings the reference returned.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeignRingsCall {
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

/// Replays provider responses captured from the TypeScript reference. Each corpus case
/// queries every band once and makes at most one tile-water and one foreign-rings call,
/// so the band is the unique key for charted areas and the single captured call answers
/// the others.
///
/// Lookups key on the band rather than the exact `(band, bbox)`: the captured bbox is the
/// TypeScript router's bbox, used here only to identify the call, and the captured polygon
/// data is the correct response regardless of a sub-ulp difference in the bbox key. The
/// engine's `route_bbox` is bit-reproducible against the reference for many inputs but not
/// all (the projection's transcendentals can differ by one or two ulp between the V8 and
/// the Rust math libraries), so keying on the exact bbox would spuriously miss the data on
/// those inputs even though the captured response is exactly what the reference returned.
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
    fn charted_areas(&self, band: ScaleBand, _bbox: Bbox) -> Option<ChartedAreas> {
        self.charted
            .iter()
            .find(|c| c.band == band)
            .and_then(|c| c.result.clone())
    }

    fn tile_water(&self, _bbox: Bbox) -> Option<TileWater> {
        self.tile.as_ref().and_then(|c| c.result.clone())
    }

    fn foreign_rings(&self, _bbox: Bbox) -> Vec<RingPolygon> {
        self.foreign
            .as_ref()
            .map(|c| c.result.clone())
            .unwrap_or_default()
    }
}
