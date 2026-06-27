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
