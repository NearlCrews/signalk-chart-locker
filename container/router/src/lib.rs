use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

/// The HTTP surface of the router container. Milestone 1 exposes liveness and an
/// empty regions list; routing endpoints arrive in later milestones.
pub fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/regions", get(regions))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn regions() -> Json<Value> {
    Json(json!([]))
}
