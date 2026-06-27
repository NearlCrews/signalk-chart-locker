use axum::routing::{get, post};
use axum::{Json, Router};
use binnacle_engine::{
    route_channel, Bbox, ChannelDeclineReason, ChannelRouteRequest, ChannelRouteResult,
    ChartedAreas, Position, Provider, RingPolygon, ScaleBand, TileWater,
};
use serde::Serialize;
use serde_json::{json, Value};

/// The HTTP surface of the router container. Milestone 1 exposes liveness and an empty
/// regions list; `route-on-water` wires the parity-proven engine onto the no-geodata
/// provider, so it declines honestly until Milestone 3 lands real geodata.
pub fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/regions", get(regions))
        .route("/route-on-water", post(route_on_water))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn regions() -> Json<Value> {
    Json(json!([]))
}

/// The no-geodata placeholder provider. It reports every query as a successful but empty
/// result: the store is present and was consulted, it simply holds nothing yet. The engine
/// reads that as `no-coverage`, the honest decline for an area with no charted water.
/// Returning `None` instead would read as a fetch failure (`fetch-failed`), which would
/// misreport an empty-but-healthy store as a transient error. Milestone 3 replaces this
/// with the LocalProvider backed by the offline geodata store.
struct EmptyProvider;

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

/// The stable wire form of a routing result. The engine returns its native `ChannelRouteResult`;
/// serializing it for HTTP is a transport concern, so the shape lives here in the router, not in
/// the geometry engine. Both booleans are always present on success, and the optionals are absent
/// on the arm that does not carry them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRouteResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    waypoints: Option<Vec<Position>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    used_tile_water: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    border_fallback: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<ChannelDeclineReason>,
}

impl From<ChannelRouteResult> for WireRouteResult {
    fn from(result: ChannelRouteResult) -> Self {
        match result {
            ChannelRouteResult::Ok { waypoints, used_tile_water, border_fallback } => Self {
                ok: true,
                waypoints: Some(waypoints),
                used_tile_water: Some(used_tile_water),
                border_fallback: Some(border_fallback),
                reason: None,
            },
            ChannelRouteResult::Decline { reason } => Self {
                ok: false,
                waypoints: None,
                used_tile_water: None,
                border_fallback: None,
                reason: Some(reason),
            },
        }
    }
}

/// Compute a water-following route for a passage. Backed by the no-geodata `EmptyProvider`,
/// so until Milestone 3 lands real geodata every request declines as `no-coverage`. The
/// result crosses the wire as the stable [`WireRouteResult`] DTO.
async fn route_on_water(Json(req): Json<ChannelRouteRequest>) -> Json<WireRouteResult> {
    let result = route_channel(&EmptyProvider, &ScaleBand::ALL, &req);
    Json(WireRouteResult::from(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The success arm carries the waypoints and both boolean flags under their camelCase
    /// wire keys, and omits `reason` entirely.
    #[test]
    fn wire_ok_carries_flags_and_omits_reason() {
        let result = ChannelRouteResult::Ok {
            waypoints: vec![Position { latitude: 1.0, longitude: 2.0 }],
            used_tile_water: true,
            border_fallback: false,
        };
        let v = serde_json::to_value(WireRouteResult::from(result)).unwrap();
        assert_eq!(
            v,
            json!({
                "ok": true,
                "waypoints": [{ "latitude": 1.0, "longitude": 2.0 }],
                "usedTileWater": true,
                "borderFallback": false
            })
        );
    }

    /// A normal request against the no-geodata provider declines as `no-coverage` without
    /// panicking, and the wire form is exactly `{"ok":false,"reason":"no-coverage"}`.
    #[tokio::test]
    async fn route_on_water_declines_no_coverage_without_geodata() {
        let req = ChannelRouteRequest {
            from: Position { latitude: 37.80, longitude: -122.50 },
            to: Position { latitude: 37.81, longitude: -122.49 },
            draft_meters: 2.0,
            safety_margin_meters: 0.5,
            standoff_nm: 0.1,
            corridor: None,
            bbox_anchors: None,
            border_aware: false,
            max_snap_meters: None,
            deadline_ms: None,
        };

        let Json(wire) = route_on_water(Json(req)).await;

        assert!(!wire.ok);
        assert_eq!(wire.reason, Some(ChannelDeclineReason::NoCoverage));
        let v = serde_json::to_value(&wire).unwrap();
        assert_eq!(v, json!({ "ok": false, "reason": "no-coverage" }));
    }
}
