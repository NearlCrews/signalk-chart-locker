//! The axum HTTP surface. The plugin (and only the plugin, over the resolved private address) reaches
//! these: GET /tile/:source/:z/:x/:y serves a cached or freshly fetched raster tile, POST /config
//! pushes the source allowlist, and /health and /cache/stats report status. The basemap /style routes
//! live in `style.rs`.

use crate::fetcher::{get_tile, FetchOutcome};
use crate::source::ChartSource;
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

/// Build the router. The style routes are added by `crate::style::style_routes`.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/cache/stats", get(stats))
        .route("/config", post(config))
        .route("/tile/:source/:z/:x/:y", get(tile))
        .route("/warm", post(warm_start))
        .route("/warm/:job_id", get(warm_status))
        .route("/warm/:job_id/cancel", post(warm_cancel))
        .merge(crate::style::style_routes())
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn stats(State(st): State<AppState>) -> Json<serde_json::Value> {
    let (rows, bytes) = st.cache.stats().unwrap_or((0, 0));
    let avg: serde_json::Map<String, serde_json::Value> = st
        .cache
        .per_source_avg()
        .unwrap_or_default()
        .into_iter()
        .map(|(source, mean)| (source, serde_json::json!(mean)))
        .collect();
    Json(serde_json::json!({
        "rows": rows,
        "bytes": bytes,
        "cap": st.knobs.cap_bytes,
        "perSourceAvgBytes": avg,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody {
    sources: Vec<ChartSource>,
    #[serde(default)]
    public_base: Option<String>,
}

/// Replace the source allowlist (and optionally the public base) atomically.
async fn config(State(st): State<AppState>, Json(body): Json<ConfigBody>) -> StatusCode {
    {
        let mut map = st.sources.write().await;
        map.clear();
        for s in body.sources {
            map.insert(s.id.clone(), s);
        }
    }
    // Drop the learned per-style templates so a re-pushed style with a changed URL or allowed hosts is
    // relearned on the next GET /style, not served from stale glyph and tile templates.
    st.style_state.write().await.clear();
    if let Some(pb) = body.public_base {
        *st.public_base.write().await = pb;
    }
    StatusCode::NO_CONTENT
}

async fn tile(State(st): State<AppState>, Path((source, z, x, y)): Path<(String, u32, u32, u32)>, headers: HeaderMap) -> Response {
    let if_none_match = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).map(str::to_string);
    match get_tile(&st, &source, z, x, y, if_none_match).await {
        FetchOutcome::Hit(t) => crate::response::tile_http_response(&t.content_type, &t.etag, t.stale, t.body, None),
        FetchOutcome::NotModified { etag } => crate::response::tile_http_response("", &etag, false, bytes::Bytes::new(), Some(&etag)),
        FetchOutcome::Empty { status } => StatusCode::from_u16(status).unwrap_or(StatusCode::NOT_FOUND).into_response(),
        FetchOutcome::NotAllowed => StatusCode::NOT_FOUND.into_response(),
        FetchOutcome::BadRequest(_) => StatusCode::BAD_REQUEST.into_response(),
        FetchOutcome::Unavailable => StatusCode::BAD_GATEWAY.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WarmBody {
    sources: Vec<String>,
    bbox: [f64; 4],
    minzoom: u32,
    maxzoom: u32,
}

// Build placeholder ChartSource values keyed only by id; start_warm resolves each against the
// allowlist (the trusted config) and rejects any unknown or style-type source. The placeholder
// fields beyond `id` are unused after resolution.
async fn warm_start(State(st): State<AppState>, Json(body): Json<WarmBody>) -> Response {
    let placeholders: Vec<crate::source::ChartSource> = body
        .sources
        .iter()
        .map(|id| crate::source::ChartSource {
            id: id.clone(),
            title: String::new(),
            upstream: crate::source::UpstreamTemplate::Xyz { url_template: String::new() },
            tile_size: 256,
            minzoom: body.minzoom,
            maxzoom: body.maxzoom,
            bounds: None,
            attribution: String::new(),
        })
        .collect();
    let req = crate::warm::WarmRequest {
        sources: placeholders,
        bbox: body.bbox,
        minzoom: body.minzoom,
        maxzoom: body.maxzoom,
    };
    match crate::warm::start_warm(&st, req).await {
        Ok(job_id) => (StatusCode::OK, Json(serde_json::json!({ "jobId": job_id }))).into_response(),
        Err(crate::warm::StartError::UnknownSource(_)) => StatusCode::NOT_FOUND.into_response(),
        Err(crate::warm::StartError::TooMany(n)) => (StatusCode::BAD_REQUEST, format!("too many tiles: {n}")).into_response(),
        Err(crate::warm::StartError::BadBbox(m)) | Err(crate::warm::StartError::BadZoom(m)) => (StatusCode::BAD_REQUEST, m).into_response(),
    }
}

async fn warm_status(State(st): State<AppState>, Path(job_id): Path<String>) -> Response {
    match crate::warm::warm_snapshot(&st, &job_id).await {
        Some(snap) => Json(snap).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn warm_cancel(State(st): State<AppState>, Path(job_id): Path<String>) -> Response {
    if crate::warm::cancel_warm(&st, &job_id).await {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::TileCache;
    use crate::state::Knobs;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::NamedTempFile;
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    async fn spawn_stub(hits: Arc<AtomicUsize>) -> SocketAddr {
        let h = hits.clone();
        let stub = Router::new().route(
            "/img/:z/:x/:y",
            get(move || {
                let h = h.clone();
                async move {
                    h.fetch_add(1, Ordering::SeqCst);
                    ([(header::CONTENT_TYPE, "image/png")], vec![9u8, 9, 9])
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, stub).await.unwrap(); });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    fn dev_state(db: &NamedTempFile) -> AppState {
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        AppState::new(cache, Knobs { allow_private_egress: true, ..Default::default() })
    }

    fn config_json(addr: SocketAddr) -> String {
        format!(
            r#"{{"sources":[{{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{{"mode":"xyz","urlTemplate":"http://{addr}/img/{{z}}/{{x}}/{{y}}"}}}}],"publicBase":"/plugins/p"}}"#
        )
    }

    async fn body_string(resp: Response) -> (StatusCode, String) {
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&bytes).to_string())
    }

    #[tokio::test]
    async fn health_is_ok_with_an_empty_allowlist() {
        let db = NamedTempFile::new().unwrap();
        let resp = app(dev_state(&db)).oneshot(Request::get("/health").body(Body::empty()).unwrap()).await.unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"status\":\"ok\""));
    }

    #[tokio::test]
    async fn config_then_tile_serves_bytes_with_an_etag() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));

        let cfg = router
            .clone()
            .oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap())
            .await
            .unwrap();
        assert_eq!(cfg.status(), StatusCode::NO_CONTENT);

        let resp = router.clone().oneshot(Request::get("/tile/s/1/0/0").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(resp.headers().get(header::ETAG).is_some());
        assert_eq!(resp.headers().get(header::CONTENT_TYPE).unwrap(), "image/png");

        // Unknown source 404s.
        let unknown = router.clone().oneshot(Request::get("/tile/nope/0/0/0").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

        // Out-of-range tile 400s (x 2 at z 1).
        let oob = router.oneshot(Request::get("/tile/s/1/2/0").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(oob.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_removed_source_stops_resolving() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();
        // Re-push an empty allowlist.
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(r#"{"sources":[]}"#)).unwrap()).await.unwrap();
        let resp = router.oneshot(Request::get("/tile/s/1/0/0").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn warm_route_rejects_too_many_tiles_with_400() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();
        // Global bbox at maxzoom 12 projects far past the 2_000_000 tile hard cap, triggering TooMany.
        let warm = router.oneshot(
            Request::post("/warm").header("content-type", "application/json")
                .body(Body::from(r#"{"sources":["s"],"bbox":[-180.0,-85.0,180.0,85.0],"minzoom":0,"maxzoom":12}"#)).unwrap()
        ).await.unwrap();
        assert_eq!(warm.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn warm_route_rejects_bad_bbox_and_bad_zoom_with_400() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();
        // Longitude-inverted bbox (west >= east) triggers BadBbox.
        let bad_bbox = router.clone().oneshot(
            Request::post("/warm").header("content-type", "application/json")
                .body(Body::from(r#"{"sources":["s"],"bbox":[10.0,-1.0,-10.0,1.0],"minzoom":0,"maxzoom":0}"#)).unwrap()
        ).await.unwrap();
        assert_eq!(bad_bbox.status(), StatusCode::BAD_REQUEST);
        // minzoom > maxzoom triggers BadZoom.
        let bad_zoom = router.oneshot(
            Request::post("/warm").header("content-type", "application/json")
                .body(Body::from(r#"{"sources":["s"],"bbox":[-1.0,-1.0,1.0,1.0],"minzoom":5,"maxzoom":2}"#)).unwrap()
        ).await.unwrap();
        assert_eq!(bad_zoom.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn cache_stats_reports_counters() {
        let db = NamedTempFile::new().unwrap();
        let resp = app(dev_state(&db)).oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap()).await.unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"rows\":0"));
    }

    #[tokio::test]
    async fn warm_route_starts_a_job_and_reports_status() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();

        let warm = router.clone().oneshot(
            Request::post("/warm").header("content-type", "application/json")
                .body(Body::from(r#"{"sources":["s"],"bbox":[-1.0,-1.0,1.0,1.0],"minzoom":0,"maxzoom":1}"#)).unwrap()
        ).await.unwrap();
        let (status, body) = body_string(warm).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"jobId\""));
        let job_id = body.split("\"jobId\":\"").nth(1).unwrap().split('"').next().unwrap().to_string();

        let status_resp = router.clone().oneshot(Request::get(format!("/warm/{job_id}")).body(Body::empty()).unwrap()).await.unwrap();
        let (status_code, status_body) = body_string(status_resp).await;
        assert_eq!(status_code, StatusCode::OK);
        assert!(status_body.contains("\"total\""), "status snapshot contains total field");
        assert!(status_body.contains("\"state\""), "status snapshot contains state field");

        let cancel = router.clone().oneshot(Request::post(format!("/warm/{job_id}/cancel")).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(cancel.status(), StatusCode::NO_CONTENT);

        let unknown = router.clone().oneshot(Request::get("/warm/nope").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn warm_route_rejects_an_unknown_source_with_404() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();
        let warm = router.oneshot(
            Request::post("/warm").header("content-type", "application/json")
                .body(Body::from(r#"{"sources":["nope"],"bbox":[-1.0,-1.0,1.0,1.0],"minzoom":0,"maxzoom":0}"#)).unwrap()
        ).await.unwrap();
        assert_eq!(warm.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cache_stats_reports_cap_and_per_source_average() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();
        // Warm one tile through the live path so a real 200 row exists.
        router.clone().oneshot(Request::get("/tile/s/1/0/0").body(Body::empty()).unwrap()).await.unwrap();
        let resp = router.oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap()).await.unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"cap\":"), "stats reports the byte cap");
        assert!(body.contains("\"perSourceAvgBytes\""), "stats reports the per-source average");
        assert!(body.contains("\"s\":"), "the warmed source has an average");
    }
}
