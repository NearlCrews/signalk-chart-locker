use axum::body::Body;
use axum::http::{Request, StatusCode};
use binnacle_router::app;
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
