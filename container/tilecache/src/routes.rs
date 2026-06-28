//! The axum HTTP surface. The plugin (and only the plugin, over the resolved private address) reaches
//! these: GET /tile/:source/:z/:x/:y serves a cached or freshly fetched raster tile, POST /config
//! pushes the source allowlist, and /health and /cache/stats report status. The basemap /style routes
//! live in `style.rs`.

use crate::fetcher::{get_tile, FetchOutcome};
use crate::source::ChartSource;
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
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
        .merge(crate::style::style_routes())
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn stats(State(st): State<AppState>) -> Json<serde_json::Value> {
    let (rows, bytes) = st.cache.stats().unwrap_or((0, 0));
    Json(serde_json::json!({ "rows": rows, "bytes": bytes }))
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
    if let Some(pb) = body.public_base {
        *st.public_base.write().await = pb;
    }
    StatusCode::NO_CONTENT
}

fn header_value(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"))
}

async fn tile(State(st): State<AppState>, Path((source, z, x, y)): Path<(String, u32, u32, u32)>, headers: HeaderMap) -> Response {
    let if_none_match = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).map(str::to_string);
    match get_tile(&st, &source, z, x, y, if_none_match).await {
        FetchOutcome::Hit(t) => {
            let mut h = HeaderMap::new();
            h.insert(header::CONTENT_TYPE, header_value(&t.content_type));
            h.insert(header::ETAG, header_value(&t.etag));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"));
            if t.stale {
                h.insert("x-tilecache", HeaderValue::from_static("stale"));
            }
            (StatusCode::OK, h, t.body).into_response()
        }
        FetchOutcome::NotModified { etag } => {
            let mut h = HeaderMap::new();
            h.insert(header::ETAG, header_value(&etag));
            (StatusCode::NOT_MODIFIED, h).into_response()
        }
        FetchOutcome::Empty { status } => StatusCode::from_u16(status).unwrap_or(StatusCode::NOT_FOUND).into_response(),
        FetchOutcome::NotAllowed => StatusCode::NOT_FOUND.into_response(),
        FetchOutcome::BadRequest(_) => StatusCode::BAD_REQUEST.into_response(),
        FetchOutcome::Unavailable => StatusCode::BAD_GATEWAY.into_response(),
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
    async fn cache_stats_reports_counters() {
        let db = NamedTempFile::new().unwrap();
        let resp = app(dev_state(&db)).oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap()).await.unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"rows\":0"));
    }
}
