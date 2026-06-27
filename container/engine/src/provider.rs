//! The replay `FileProvider`: serves captured corpus fixtures keyed by the query
//! inputs, so the Rust engine and the TypeScript reference see identical provider
//! responses. This is Phase C of the Milestone 2 plan; stub for now.

use crate::types::{Bbox, ChartedAreas, Provider, RingPolygon, ScaleBand, TileWater};

/// Replays provider responses captured from the TypeScript reference. Lookups are
/// keyed by the rounded query inputs so a captured `(band, bbox)` or `(bbox)` call
/// resolves to the exact response the reference saw.
pub struct FileProvider {
    _private: (),
}

impl FileProvider {
    /// Load a captured corpus case from its fixtures file.
    pub fn from_fixtures_json(json: &str) -> serde_json::Result<Self> {
        todo!("parse the captured fixtures into keyed lookups")
    }
}

impl Provider for FileProvider {
    fn charted_areas(&self, band: ScaleBand, bbox: Bbox) -> Option<ChartedAreas> {
        todo!("replay the captured charted areas for (band, bbox)")
    }
    fn tile_water(&self, bbox: Bbox) -> Option<TileWater> {
        todo!("replay the captured tile water for bbox")
    }
    fn foreign_rings(&self, bbox: Bbox) -> Vec<RingPolygon> {
        todo!("replay the captured foreign rings for bbox")
    }
}
