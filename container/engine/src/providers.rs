//! Reusable `Provider` stubs the router imports for the no-store and broken-store paths.
//! Kept here so the engine owns the two trivial degenerate providers and the router does
//! not redefine them. The impls are byte-for-byte the ones the router used in-tree.

use crate::types::{Bbox, ChartedAreas, Provider, RingPolygon, ScaleBand, TileWater};

/// The no-geodata placeholder provider. It reports every query as a successful but empty
/// result: the store is present and was consulted, it simply holds nothing yet. The engine
/// reads that as `no-coverage`, the honest decline for an area with no charted water.
/// Returning `None` instead would read as a fetch failure (`fetch-failed`), which would
/// misreport an empty-but-healthy store as a transient error.
pub struct EmptyProvider;

impl Provider for EmptyProvider {
    fn charted_areas(&self, _band: ScaleBand, _bbox: Bbox) -> Option<ChartedAreas> {
        Some(ChartedAreas::default())
    }

    fn tile_water(&self, _bbox: Bbox) -> Option<TileWater> {
        Some(TileWater::default())
    }

    fn foreign_rings(&self, _bbox: Bbox) -> Vec<RingPolygon> {
        Vec::new()
    }
}

/// A provider that reports every read as failed. A configured-but-unopenable store routes over
/// this so the engine declines fetch-failed, the honest signal that the data source broke.
pub struct UnavailableProvider;

impl Provider for UnavailableProvider {
    fn charted_areas(&self, _band: ScaleBand, _bbox: Bbox) -> Option<ChartedAreas> {
        None
    }
    fn tile_water(&self, _bbox: Bbox) -> Option<TileWater> {
        None
    }
    fn foreign_rings(&self, _bbox: Bbox) -> Vec<RingPolygon> {
        Vec::new()
    }
}
