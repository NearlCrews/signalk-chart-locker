//! Shared types crossing every module boundary, and the `Provider` trait the
//! engine consumes. These mirror the crows-nest channel-router contract so a
//! replay corpus captured from the TypeScript reference deserializes directly.
//! Field names use serde camelCase where the corpus JSON does, so the wire shape
//! matches the TypeScript source.

use serde::{Deserialize, Serialize};

/// A geographic position, degrees. Matches the TypeScript `Position`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub latitude: f64,
    pub longitude: f64,
}

/// An axis-aligned geographic window, degrees. Matches the TypeScript `Bbox`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bbox {
    pub north: f64,
    pub south: f64,
    pub east: f64,
    pub west: f64,
}

/// A single ring as `[lon, lat]` vertices, the GeoJSON winding the providers emit.
pub type Ring = Vec<[f64; 2]>;
/// A polygon as an outer ring followed by hole rings.
pub type Rings = Vec<Ring>;

/// The six NOAA ENC Direct scale bands, ordered overview to berthing. Serializes
/// to the lowercase wire values the corpus keys on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScaleBand {
    Overview,
    General,
    Coastal,
    Approach,
    Harbour,
    Berthing,
}

impl ScaleBand {
    /// The six NOAA ENC Direct usage bands in canonical coarse-to-fine order, overview through
    /// berthing. A caller routing over the full chart set queries the provider in this order.
    pub const ALL: [ScaleBand; 6] = [
        ScaleBand::Overview,
        ScaleBand::General,
        ScaleBand::Coastal,
        ScaleBand::Approach,
        ScaleBand::Harbour,
        ScaleBand::Berthing,
    ];
}

/// The depth attributes of an ENC depth area. The router reads only `shallow_meters`
/// (DRVAL1); a negative value is a drying height and is treated as land.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthRange {
    pub shallow_meters: Option<f64>,
    pub deep_meters: Option<f64>,
}

/// One ENC area polygon. The router reads only `rings` and `depth_range.shallow_meters`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncAreaPolygon {
    pub rings: Rings,
    #[serde(default)]
    pub depth_range: Option<DepthRange>,
}

/// The ENC charted areas for one `(band, bbox)` query.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartedAreas {
    pub depth_areas: Vec<EncAreaPolygon>,
    pub land_areas: Vec<EncAreaPolygon>,
}

/// One tile-water polygon: an outer water ring with island holes after it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AreaPolygon {
    pub rings: Rings,
}

/// The vector-tile water result for one bbox query.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TileWater {
    pub water: Vec<AreaPolygon>,
}

/// A foreign-country water polygon to block for border-aware routing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RingPolygon {
    pub rings: Rings,
}

/// A typed reason the router could not produce a water route. Serializes to the
/// kebab-case wire values the TypeScript reference emits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChannelDeclineReason {
    NoCoverage,
    NoPath,
    Deadline,
    Unsnappable,
    LandLeg,
    FetchFailed,
}

/// The result of `route_channel`: the water route, or the reason it could not build one.
#[derive(Debug, Clone, PartialEq)]
pub enum ChannelRouteResult {
    Ok {
        waypoints: Vec<Position>,
        used_tile_water: bool,
        border_fallback: bool,
    },
    Decline {
        reason: ChannelDeclineReason,
    },
}

/// Parameters describing the passage to route. Mirrors the TypeScript
/// `ChannelRouteRequest`; the function-valued `foreignRings` field becomes the
/// `border_aware` flag here, with the rings supplied by the `Provider`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRouteRequest {
    pub from: Position,
    pub to: Position,
    pub draft_meters: f64,
    pub safety_margin_meters: f64,
    pub standoff_nm: f64,
    #[serde(default)]
    pub corridor: Option<Vec<Position>>,
    #[serde(default)]
    pub bbox_anchors: Option<Vec<Position>>,
    /// When true, the engine blocks the foreign water the provider returns for the
    /// route bbox. Mirrors the presence of `foreignRings` on the TypeScript request.
    #[serde(default)]
    pub border_aware: bool,
    #[serde(default)]
    pub max_snap_meters: Option<f64>,
    #[serde(default)]
    pub deadline_ms: Option<f64>,
    /// The home country for border-aware routing. Absent means no border filter.
    #[serde(default)]
    pub home_country_id: Option<String>,
}

/// The data sources the router consumes, one method per call the TypeScript router
/// makes. A `FileProvider` replays a captured corpus; a `LocalProvider` will read
/// the offline geodata store in a later milestone.
pub trait Provider {
    /// ENC charted areas for one band over the bbox. `None` means the band failed
    /// (the router tolerates individual band failures).
    fn charted_areas(&self, band: ScaleBand, bbox: Bbox) -> Option<ChartedAreas>;
    /// Vector-tile water over the bbox. `None` means every tile failed.
    fn tile_water(&self, bbox: Bbox) -> Option<TileWater>;
    /// Foreign-country water rings over the bbox, for border-aware routing. Empty
    /// when border routing is off or no foreign water overlaps.
    fn foreign_rings(&self, bbox: Bbox) -> Vec<RingPolygon>;
}
