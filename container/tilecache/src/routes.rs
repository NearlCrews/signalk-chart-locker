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
use std::sync::atomic::Ordering;

/// Build the router. The style routes are added by `crate::style::style_routes`.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/cache/stats", get(stats))
        .route("/config", post(config))
        .route("/cache/scroll-ttl", post(set_scroll_ttl))
        .route("/cache/clear-scroll", post(clear_scroll))
        .route("/cache/regions", get(all_region_bytes_route))
        .route("/tile/{source}/{z}/{x}/{y}", get(tile))
        .route("/warm", post(warm_start))
        .route("/warm/{job_id}", get(warm_status))
        .route("/warm/{job_id}/cancel", post(warm_cancel))
        .route(
            "/cache/region/{region_id}",
            axum::routing::get(region_bytes_route).delete(delete_region_route),
        )
        .merge(crate::style::style_routes())
        .merge(crate::geocode::geocode_routes())
        .with_state(state)
}

async fn health(State(st): State<AppState>) -> Response {
    let cache = st.cache.clone();
    let database_ready = matches!(
        tokio::task::spawn_blocking(move || cache.probe()).await,
        Ok(Ok(()))
    );
    let configured = st.configured.load(Ordering::Relaxed);
    let status = if database_ready { "ok" } else { "degraded" };
    let body = Json(serde_json::json!({
        "status": status,
        "databaseReady": database_ready,
        "configured": configured
    }));
    if database_ready {
        body.into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, body).into_response()
    }
}

async fn stats(State(st): State<AppState>) -> Json<serde_json::Value> {
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    let r = st.live_regions_budget.load(Ordering::Relaxed);
    let p = st.live_position_warm_budget.load(Ordering::Relaxed);
    let configured = st.configured.load(Ordering::Relaxed);
    let available_bytes = st.cache.available_bytes().ok();
    // Run the SQLite reads on a blocking thread. real_region_pinned_bytes probes region_tiles per pinned
    // tile, so on a large cache it can scan for many seconds; keeping it off the async runtime stops one
    // stats call from wedging the async reactor. Each cache read degrades to its zero value on an
    // error, matching the prior unwrap_or, and the whole tuple defaults to zeros on a task join failure.
    let cache = st.cache.clone();
    let (rows, bytes, pinned_bytes, pw, real_pinned, source_rows) =
        tokio::task::spawn_blocking(move || {
            let (rows, bytes, pinned_bytes) = cache.stats().unwrap_or((0, 0, 0));
            // The position-warm pseudo-region's pinned bytes, reported as positionWarmBytes.
            let pw = cache
                .region_bytes(crate::state::POSITION_WARM_REGION_ID)
                .unwrap_or(0);
            // The exact real-region pinned bytes: a tile shared between a real region and the position-warm
            // pseudo-region counts once here, so the regions budget gate is not under-counted by subtracting
            // a shared tile fully.
            let real_pinned = cache
                .real_region_pinned_bytes(crate::state::POSITION_WARM_REGION_ID)
                .unwrap_or(0);
            let source_rows = cache.per_source_stats().unwrap_or_default();
            (rows, bytes, pinned_bytes, pw, real_pinned, source_rows)
        })
        .await
        .unwrap_or_default();
    let avg: serde_json::Map<String, serde_json::Value> = source_rows
        .iter()
        .filter_map(|stats| {
            stats
                .average_bytes
                .map(|value| (stats.source.clone(), serde_json::json!(value)))
        })
        .collect();
    let by_source: Vec<serde_json::Value> = source_rows
        .into_iter()
        .filter(|stats| stats.scroll_rows > 0)
        .map(|stats| {
            serde_json::json!({
                "source": stats.source,
                "bytes": stats.scroll_bytes,
                "rows": stats.scroll_rows
            })
        })
        .collect();
    // Per-source upstream health, present only for sources with a live health entry. The in-memory
    // snapshot is a fast lock, so it runs on the reactor rather than the blocking cache pool. timeoutSecs
    // is the adaptive timeout in whole seconds, rounded up so a sub-second remainder never floors to a
    // smaller reported timeout; lastTimeoutAt is Unix epoch seconds.
    let upstream: serde_json::Map<String, serde_json::Value> = st
        .upstream_health
        .snapshot()
        .into_iter()
        .map(|h| {
            (
                h.source,
                serde_json::json!({
                    "slow": h.streak > 0,
                    "timeoutSecs": h.timeout_ms.div_ceil(1000),
                    "lastTimeoutAt": h.last_timeout_at,
                }),
            )
        })
        .collect();
    Json(serde_json::json!({
        "rows": rows,
        "bytes": bytes,
        "cap": cap,
        "pinnedBytes": pinned_bytes,
        "scrollBytes": (bytes - pinned_bytes).max(0),
        "regionsBudgetBytes": r,
        "positionWarmBudgetBytes": p,
        "positionWarmBytes": pw,
        // Free room for new real regions: (R - P) minus the real-region pinned bytes, floored at 0. The
        // position-warm pseudo-region is gated at R, not P, so its bytes pw can structurally exceed P;
        // when it does, this figure can over-grant. Soft reserve degrades gracefully: the cap-clamped
        // R - P gate, plus make-room evicting only unpinned, plus never evicting a pinned tile, still
        // hold total <= cap, so an over-granted real-region warm simply caps. The value does not lean on
        // pw <= P.
        "regionsFreeBytes": ((r - p) - real_pinned).max(0),
        "perSourceAvgBytes": avg,
        "bySource": by_source,
        "upstream": upstream,
        "configured": configured,
        "availableBytes": available_bytes,
        "minimumHeadroomBytes": crate::cache::MIN_FREE_HEADROOM_BYTES,
        "diskPressure": available_bytes.map(|bytes| bytes < crate::cache::MIN_FREE_HEADROOM_BYTES),
        "diagnostics": {
            "diskPressureEvents": st.cache.disk_pressure_events(),
            "warmRejections": st.warm_rejections.load(Ordering::Relaxed),
            "configPushes": st.config_pushes.load(Ordering::Relaxed),
            "cacheOperationErrors": st.cache.operation_error_events()
                + st.cache_operation_errors.load(Ordering::Relaxed),
        },
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody {
    sources: Vec<ChartSource>,
    // public_base stays verbatim: serde rename_all = "camelCase" maps it to the wire key publicBase,
    // which the plugin already sends.
    #[serde(default)]
    public_base: Option<String>,
    #[serde(default)]
    cap_bytes: Option<i64>,
    #[serde(default)]
    regions_budget_bytes: Option<i64>,
    #[serde(default)]
    position_warm_budget_bytes: Option<i64>,
    #[serde(default)]
    scroll_ttl_secs: Option<i64>,
}

/// Replace the source allowlist (and optionally the public base and the cap and budget knobs) atomically.
///
/// Lowering R (or P) below the currently pinned bytes is the owner's deliberate action and is accepted
/// as-is. Existing pins are not retroactively trimmed; under the soft reserve a region warm only ever
/// evicts unpinned scroll tiles, so the pinned set can sit above the new R until a re-download or a
/// per-region delete converges it. The physical total stays at or below the cap throughout. This is
/// documented and acceptable, not a bug.
async fn config(State(st): State<AppState>, Json(body): Json<ConfigBody>) -> StatusCode {
    let source_count = body.sources.len();
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
    if let Some(c) = body.cap_bytes {
        st.live_cap_bytes.store(c, Ordering::Relaxed);
    }
    if let Some(r) = body.regions_budget_bytes {
        st.live_regions_budget.store(r, Ordering::Relaxed);
    }
    if let Some(p) = body.position_warm_budget_bytes {
        st.live_position_warm_budget.store(p, Ordering::Relaxed);
    }
    if let Some(t) = body.scroll_ttl_secs {
        st.live_scroll_ttl_secs.store(t, Ordering::Relaxed);
    }
    st.configured.store(true, Ordering::Relaxed);
    st.config_pushes.fetch_add(1, Ordering::Relaxed);
    eprintln!("event=config_push_applied sources={source_count}");
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrollTtlBody {
    ttl_secs: i64,
}

/// POST /cache/scroll-ttl: set only the live scroll TTL. A dedicated route so a live TTL edit does
/// not re-push the source allowlist or clear the learned style state, which POST /config does.
async fn set_scroll_ttl(State(st): State<AppState>, Json(body): Json<ScrollTtlBody>) -> StatusCode {
    st.live_scroll_ttl_secs
        .store(body.ttl_secs, Ordering::Relaxed);
    StatusCode::NO_CONTENT
}

/// POST /cache/clear-scroll: delete every unpinned scroll tile, keeping pinned region and
/// position-warm tiles. Runs on a blocking thread because the chunked delete is synchronous.
async fn clear_scroll(State(st): State<AppState>) -> Response {
    let cache = st.cache.clone();
    match tokio::task::spawn_blocking(move || cache.clear_unpinned()).await {
        Ok(Ok((bytes, rows))) => {
            Json(serde_json::json!({ "freedBytes": bytes, "freedRows": rows })).into_response()
        }
        Ok(Err(e)) => {
            st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("tilecache: clear_unpinned failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("tilecache: clear_unpinned task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// GET /cache/region/:region_id: the total bytes a region currently pins.
async fn region_bytes_route(State(st): State<AppState>, Path(region_id): Path<String>) -> Response {
    let cache = st.cache.clone();
    match tokio::task::spawn_blocking(move || cache.region_bytes(&region_id)).await {
        Ok(Ok(bytes)) => Json(serde_json::json!({ "bytes": bytes })).into_response(),
        Ok(Err(e)) => {
            st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("tilecache: region_bytes failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("tilecache: region_bytes task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// GET /cache/regions: all region byte totals in one SQLite query.
async fn all_region_bytes_route(State(st): State<AppState>) -> Response {
    let cache = st.cache.clone();
    match tokio::task::spawn_blocking(move || cache.all_region_bytes()).await {
        Ok(Ok(rows)) => {
            let regions: serde_json::Map<String, serde_json::Value> = rows
                .into_iter()
                .map(|(id, bytes)| (id, serde_json::json!(bytes)))
                .collect();
            Json(serde_json::json!({ "regions": regions })).into_response()
        }
        Ok(Err(e)) => {
            st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("event=cache_region_totals_failed error={e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("event=cache_region_totals_task_failed error={e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// DELETE /cache/region/:region_id: drop a region's pins, then bound the scroll cache at the cap.
async fn delete_region_route(
    State(st): State<AppState>,
    Path(region_id): Path<String>,
) -> StatusCode {
    // The reserved pseudo-regions (position-warm and basemap assets) are managed by the warm engine, not
    // by the region API, so refuse to let a caller unpin them out from under it.
    if region_id == crate::state::POSITION_WARM_REGION_ID
        || region_id == crate::state::BASEMAP_ASSETS_REGION_ID
    {
        return StatusCode::FORBIDDEN;
    }
    let cache = st.cache.clone();
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    // delete_region walks region_tiles and can demote many pinned rows, so run it and the follow-up
    // evict_to on a blocking thread rather than on the async runtime.
    let result = tokio::task::spawn_blocking(move || {
        cache.delete_region(&region_id)?;
        // delete_region demotes refcount-zero tiles from pinned to unpinned without changing
        // total_bytes, so the total is already at or below the cap and this evict_to is effectively a
        // no-op. Kept for safety: it cannot exceed the cap and trims nothing it should keep.
        crate::fetcher::log_cache_err(&cache, "cache_eviction_failed", cache.evict_to(cap));
        Ok::<(), rusqlite::Error>(())
    })
    .await;
    match result {
        Ok(Ok(())) => StatusCode::NO_CONTENT,
        Ok(Err(e)) => {
            eprintln!("tilecache: delete_region failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
        Err(e) => {
            eprintln!("tilecache: delete_region task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

async fn tile(
    State(st): State<AppState>,
    Path((source, z, x, y)): Path<(String, u32, u32, u32)>,
    headers: HeaderMap,
) -> Response {
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    match get_tile(&st, &source, z, x, y, if_none_match).await {
        FetchOutcome::Hit(t) => {
            crate::response::tile_http_response(&t.content_type, &t.etag, t.stale, t.body, None)
        }
        FetchOutcome::NotModified { etag } => {
            crate::response::tile_http_response("", &etag, false, bytes::Bytes::new(), Some(&etag))
        }
        FetchOutcome::Empty { status } => StatusCode::from_u16(status)
            .unwrap_or(StatusCode::NOT_FOUND)
            .into_response(),
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
    #[serde(default)]
    additional_bbox: Option<[f64; 4]>,
    minzoom: u32,
    maxzoom: u32,
    #[serde(default)]
    region_id: Option<String>,
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
            upstream: crate::source::UpstreamTemplate::Xyz {
                url_template: String::new(),
            },
            tile_size: 256,
            minzoom: body.minzoom,
            maxzoom: body.maxzoom,
            vector_maxzoom: None,
            bounds: None,
            attribution: String::new(),
        })
        .collect();
    let req = crate::warm::WarmRequest {
        sources: placeholders,
        bbox: body.bbox,
        additional_bbox: body.additional_bbox,
        minzoom: body.minzoom,
        maxzoom: body.maxzoom,
        region_id: body.region_id,
    };
    match crate::warm::start_warm(&st, req).await {
        Ok(job_id) => {
            (StatusCode::OK, Json(serde_json::json!({ "jobId": job_id }))).into_response()
        }
        Err(crate::warm::StartError::UnknownSource(_)) => {
            st.warm_rejections.fetch_add(1, Ordering::Relaxed);
            eprintln!("event=warm_rejected reason=unknown_source");
            StatusCode::NOT_FOUND.into_response()
        }
        Err(crate::warm::StartError::TooMany(n)) => {
            st.warm_rejections.fetch_add(1, Ordering::Relaxed);
            eprintln!("event=warm_rejected reason=tile_limit tiles={n}");
            (StatusCode::BAD_REQUEST, format!("too many tiles: {n}")).into_response()
        }
        Err(crate::warm::StartError::BadBbox(m)) | Err(crate::warm::StartError::BadZoom(m)) => {
            st.warm_rejections.fetch_add(1, Ordering::Relaxed);
            eprintln!("event=warm_rejected reason=invalid_geometry");
            (StatusCode::BAD_REQUEST, m).into_response()
        }
        Err(crate::warm::StartError::TooManyJobs) => {
            st.warm_rejections.fetch_add(1, Ordering::Relaxed);
            eprintln!("event=warm_rejected reason=job_limit");
            StatusCode::TOO_MANY_REQUESTS.into_response()
        }
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
            "/img/{z}/{x}/{y}",
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
        tokio::spawn(async move {
            axum::serve(listener, stub).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    fn dev_state(db: &NamedTempFile) -> AppState {
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        AppState::new(
            cache,
            Knobs {
                allow_private_egress: true,
                ..Default::default()
            },
        )
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
        let resp = app(dev_state(&db))
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"status\":\"ok\""));
        assert!(body.contains("\"databaseReady\":true"));
        assert!(body.contains("\"configured\":false"));
    }

    #[tokio::test]
    async fn config_then_tile_serves_bytes_with_an_etag() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));

        let cfg = router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cfg.status(), StatusCode::NO_CONTENT);

        let resp = router
            .clone()
            .oneshot(Request::get("/tile/s/1/0/0").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(resp.headers().get(header::ETAG).is_some());
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "image/png"
        );

        // Unknown source 404s.
        let unknown = router
            .clone()
            .oneshot(
                Request::get("/tile/nope/0/0/0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

        // Out-of-range tile 400s (x 2 at z 1).
        let oob = router
            .oneshot(Request::get("/tile/s/1/2/0").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(oob.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_removed_source_stops_resolving() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr)))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Re-push an empty allowlist.
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"sources":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let resp = router
            .oneshot(Request::get("/tile/s/1/0/0").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn warm_route_rejects_too_many_tiles_with_400() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr)))
                    .unwrap(),
            )
            .await
            .unwrap();
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
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr)))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Longitude-inverted bbox (west >= east) triggers BadBbox.
        let bad_bbox = router
            .clone()
            .oneshot(
                Request::post("/warm")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"sources":["s"],"bbox":[10.0,-1.0,-10.0,1.0],"minzoom":0,"maxzoom":0}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad_bbox.status(), StatusCode::BAD_REQUEST);
        // minzoom > maxzoom triggers BadZoom.
        let bad_zoom = router
            .oneshot(
                Request::post("/warm")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"sources":["s"],"bbox":[-1.0,-1.0,1.0,1.0],"minzoom":5,"maxzoom":2}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad_zoom.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn cache_stats_reports_counters() {
        let db = NamedTempFile::new().unwrap();
        let resp = app(dev_state(&db))
            .oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"rows\":0"));
        assert!(body.contains("\"diagnostics\""));
        assert!(body.contains("\"availableBytes\""));
    }

    #[tokio::test]
    async fn all_region_bytes_route_returns_one_batched_map() {
        let db = NamedTempFile::new().unwrap();
        let resp = app(dev_state(&db))
            .oneshot(Request::get("/cache/regions").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, r#"{"regions":{}}"#);
    }

    #[tokio::test]
    async fn warm_route_starts_a_job_and_reports_status() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr)))
                    .unwrap(),
            )
            .await
            .unwrap();

        let warm = router
            .clone()
            .oneshot(
                Request::post("/warm")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"sources":["s"],"bbox":[-1.0,-1.0,1.0,1.0],"minzoom":0,"maxzoom":1}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_string(warm).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"jobId\""));
        let job_id = body
            .split("\"jobId\":\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_string();

        let status_resp = router
            .clone()
            .oneshot(
                Request::get(format!("/warm/{job_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status_code, status_body) = body_string(status_resp).await;
        assert_eq!(status_code, StatusCode::OK);
        assert!(
            status_body.contains("\"total\""),
            "status snapshot contains total field"
        );
        assert!(
            status_body.contains("\"state\""),
            "status snapshot contains state field"
        );

        let cancel = router
            .clone()
            .oneshot(
                Request::post(format!("/warm/{job_id}/cancel"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancel.status(), StatusCode::NO_CONTENT);

        let unknown = router
            .clone()
            .oneshot(Request::get("/warm/nope").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn warm_route_returns_429_when_job_cap_is_reached() {
        use axum::routing::get as aget;
        // Slow stub keeps jobs in Running state long enough to fill the cap.
        let slow = Router::new().route(
            "/slow/{z}/{x}/{y}",
            aget(|| async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                ([(header::CONTENT_TYPE, "image/png")], vec![1u8])
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, slow).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let db = NamedTempFile::new().unwrap();
        let slow_cfg = format!(
            r#"{{"sources":[{{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":4,"attribution":"",
                "upstream":{{"mode":"xyz","urlTemplate":"http://{addr}/slow/{{z}}/{{x}}/{{y}}"}}}}],"publicBase":"/p"}}"#
        );
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(slow_cfg))
                    .unwrap(),
            )
            .await
            .unwrap();

        // Fill all MAX_ACTIVE_WARM_JOBS slots with large-bbox jobs that won't finish quickly.
        for _ in 0..crate::warm::MAX_ACTIVE_WARM_JOBS {
            let r = router.clone().oneshot(
                Request::post("/warm").header("content-type","application/json")
                    .body(Body::from(r#"{"sources":["s"],"bbox":[-180.0,-85.0,180.0,85.0],"minzoom":0,"maxzoom":4}"#)).unwrap()
            ).await.unwrap();
            assert_eq!(r.status(), StatusCode::OK);
        }

        // The next start must return 429.
        let extra = router
            .clone()
            .oneshot(
                Request::post("/warm")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"sources":["s"],"bbox":[-1.0,-1.0,1.0,1.0],"minzoom":0,"maxzoom":0}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(extra.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn warm_route_rejects_an_unknown_source_with_404() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr)))
                    .unwrap(),
            )
            .await
            .unwrap();
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
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr)))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Warm one tile through the live path so a real 200 row exists.
        router
            .clone()
            .oneshot(Request::get("/tile/s/1/0/0").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let resp = router
            .oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"cap\":"), "stats reports the byte cap");
        assert!(
            body.contains("\"perSourceAvgBytes\""),
            "stats reports the per-source average"
        );
        assert!(body.contains("\"s\":"), "the warmed source has an average");
    }

    #[tokio::test]
    async fn cache_stats_reports_by_source() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr)))
                    .unwrap(),
            )
            .await
            .unwrap();
        router
            .clone()
            .oneshot(Request::get("/tile/s/1/0/0").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let resp = router
            .oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("\"bySource\""),
            "stats reports the per-source totals array"
        );
        assert!(
            body.contains("\"source\":\"s\""),
            "the warmed source appears in the per-source totals"
        );
    }

    #[tokio::test]
    async fn cache_stats_reports_upstream_health() {
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        // Record a timeout so the source has a live entry: streak 1 at the 20s default base is a 40s timeout.
        state
            .upstream_health
            .record_timeout("depth-noaa", crate::state::now_secs());
        let resp = app(state.clone())
            .oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("\"upstream\""),
            "stats reports the upstream health map"
        );
        assert!(
            body.contains("\"depth-noaa\""),
            "the slow source appears under upstream"
        );
        assert!(body.contains("\"slow\":true"));
        assert!(
            body.contains("\"timeoutSecs\":40"),
            "the escalated timeout is reported in seconds"
        );
    }

    #[tokio::test]
    async fn config_sets_the_live_scroll_ttl() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let router = app(state.clone());
        let cfg = format!(
            r#"{{"sources":[{{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{{"mode":"xyz","urlTemplate":"http://{addr}/img/{{z}}/{{x}}/{{y}}"}}}}],"publicBase":"/p","scrollTtlSecs":86400}}"#
        );
        let resp = router
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(cfg))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            state.live_scroll_ttl_secs.load(Ordering::Relaxed),
            86_400,
            "the pushed TTL reaches the live field"
        );
    }

    #[tokio::test]
    async fn scroll_ttl_route_sets_the_live_ttl_and_sweep_uses_it() {
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        state
            .cache
            .put(
                crate::cache::TileKey::new("s", 0, 0, 0),
                &crate::cache::CachedTile {
                    content_type: "image/png".into(),
                    strong_etag: "e".into(),
                    upstream_validator: None,
                    status: 200,
                    fetched_at: 0,
                    last_access: 0,
                    bytes: 10,
                    blob: Some(bytes::Bytes::from(vec![0u8; 10])),
                },
                false,
                0,
            )
            .unwrap();
        let router = app(state.clone());
        let set = router
            .clone()
            .oneshot(
                Request::post("/cache/scroll-ttl")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"ttlSecs":1}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(set.status(), StatusCode::NO_CONTENT);
        assert_eq!(state.live_scroll_ttl_secs.load(Ordering::Relaxed), 1);
        let (freed, rows) = state
            .cache
            .sweep_aged_unpinned(
                state.live_scroll_ttl_secs.load(Ordering::Relaxed),
                1_000_000,
            )
            .unwrap();
        assert_eq!((freed, rows), (10, 1));
    }

    #[tokio::test]
    async fn clear_scroll_route_reports_freed_and_keeps_pinned() {
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        state
            .cache
            .put(
                crate::cache::TileKey::new("s", 0, 0, 0),
                &crate::cache::CachedTile {
                    content_type: "image/png".into(),
                    strong_etag: "e".into(),
                    upstream_validator: None,
                    status: 200,
                    fetched_at: 0,
                    last_access: 0,
                    bytes: 25,
                    blob: Some(bytes::Bytes::from(vec![0u8; 25])),
                },
                false,
                0,
            )
            .unwrap();
        let router = app(state.clone());
        let resp = router
            .oneshot(
                Request::post("/cache/clear-scroll")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("\"freedBytes\":25"),
            "reports the freed bytes"
        );
        assert!(body.contains("\"freedRows\":1"), "reports the freed rows");
    }
}
