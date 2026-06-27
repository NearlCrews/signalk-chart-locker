use axum::body::Body;
use axum::http::{Request, StatusCode};
use binnacle_localprovider::fixture::StoreBuilder;
use binnacle_router::{app, app_with_store};
use http_body_util::BodyExt;
use tower::ServiceExt; // brings `oneshot` onto Router

#[tokio::test]
async fn health_returns_status_ok() {
    let response = app()
        .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["status"], "ok");
}

#[tokio::test]
async fn regions_returns_empty_array() {
    let response = app()
        .oneshot(Request::builder().uri("/regions").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(value.as_array().expect("expected a JSON array").is_empty());
}

/// A request over a fixture store with a wide deep-water square returns a real route.
/// The depth area uses drval1 = 20.0, well above the contour of draftMeters (2.0) +
/// safetyMarginMeters (0.5) = 2.5 m. Matching tile water covers the same area so both
/// the ENC and tile-water paths are exercised.
#[tokio::test]
async fn route_on_water_returns_a_route_over_a_configured_store() {
    // A wide deep-water square covering lon -1..3, lat -1..3, with both endpoints inside.
    let big: &[[f64; 2]] = &[[-1.0, -1.0], [3.0, -1.0], [3.0, 3.0], [-1.0, 3.0], [-1.0, -1.0]];
    let store = StoreBuilder::new()
        .depth_area("coastal", Some(20.0), Some(50.0), &[big])
        .water(&[big])
        .build();

    let app = app_with_store(Some(store.path().to_path_buf()));
    let body = serde_json::json!({
        "from": { "latitude": 0.5, "longitude": 0.5 },
        "to": { "latitude": 0.5, "longitude": 1.5 },
        "draftMeters": 2.0,
        "safetyMarginMeters": 0.5,
        "standoffNm": 0.01,
        "borderAware": false
    })
    .to_string();
    let resp = app
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
    assert_eq!(v["ok"], true, "expected a route, got {v}");
    assert!(v["waypoints"].as_array().unwrap().len() >= 2);
    // store kept alive until here so the tempfile is not deleted before the request runs
    drop(store);
}

#[tokio::test]
async fn route_on_water_declines_no_coverage() {
    // End to end: the route is registered, the JSON body deserializes into the engine
    // request, and the no-geodata provider yields a `no-coverage` decline on the wire.
    let body = serde_json::json!({
        "from": { "latitude": 37.80, "longitude": -122.50 },
        "to": { "latitude": 37.81, "longitude": -122.49 },
        "draftMeters": 2.0,
        "safetyMarginMeters": 0.5,
        "standoffNm": 0.1
    })
    .to_string();
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/route-on-water")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value, serde_json::json!({ "ok": false, "reason": "no-coverage" }));
}
