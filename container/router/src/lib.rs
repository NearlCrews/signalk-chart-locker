use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use binnacle_engine::{
    route_channel, Bbox, ChannelDeclineReason, ChannelRouteRequest, ChannelRouteResult,
    ChartedAreas, Position, Provider, RingPolygon, ScaleBand, TileWater,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// The HTTP surface of the router container with no region store configured: every route
/// declines no-coverage. Used by tests that do not exercise the geodata read path.
pub fn app() -> Router {
    app_with_store(None)
}

/// The HTTP surface bound to an optional region store.
///
/// When `store_path` is `Some`, the route handler opens the store per request with
/// `LocalProvider`. When it is `None`, the handler falls back to `EmptyProvider` so every
/// route declines no-coverage, the honest signal for an area with no charted water.
pub fn app_with_store(store_path: Option<PathBuf>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/regions", get(regions))
        .route("/route-on-water", post(route_on_water))
        .with_state(RouterState { store_path: Arc::new(store_path) })
}

#[derive(Clone)]
struct RouterState {
    store_path: Arc<Option<PathBuf>>,
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
/// misreport an empty-but-healthy store as a transient error.
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

/// A provider that reports every read as failed. A configured-but-unopenable store routes over
/// this so the engine declines fetch-failed, the honest signal that the data source broke.
struct UnavailableProvider;

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

/// Compute a water-following route for a passage. With a configured region store the engine
/// routes over real charted water; without one every request declines as `no-coverage`. The
/// result crosses the wire as the stable [`WireRouteResult`] DTO.
async fn route_on_water(
    State(state): State<RouterState>,
    Json(req): Json<ChannelRouteRequest>,
) -> Json<WireRouteResult> {
    let result = match state.store_path.as_ref() {
        Some(path) => {
            match binnacle_localprovider::LocalProvider::open(path, req.home_country_id.clone()) {
                Ok(provider) => route_channel(&provider, &ScaleBand::ALL, &req),
                // A configured store that will not open is a genuine failure, not absent coverage.
                // UnavailableProvider returns None for both reads so the engine declines fetch-failed.
                Err(_) => route_channel(&UnavailableProvider, &ScaleBand::ALL, &req),
            }
        }
        // No store configured (the pre-store default): the engine declines no-coverage.
        None => route_channel(&EmptyProvider, &ScaleBand::ALL, &req),
    };
    Json(WireRouteResult::from(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

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
        let body = serde_json::json!({
            "from": { "latitude": 37.80, "longitude": -122.50 },
            "to": { "latitude": 37.81, "longitude": -122.49 },
            "draftMeters": 2.0,
            "safetyMarginMeters": 0.5,
            "standoffNm": 0.1
        })
        .to_string();
        let resp = app()
            .oneshot(
                Request::post("/route-on-water")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v, json!({ "ok": false, "reason": "no-coverage" }));
    }
}
