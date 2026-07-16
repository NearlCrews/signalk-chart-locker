//! The axum HTTP surface. The plugin (and only the plugin, over the resolved private address) reaches
//! these: GET /tile/:source/:z/:x/:y serves a cached or freshly fetched raster tile, POST /config
//! pushes the source allowlist, and /health and /cache/stats report status. The basemap /style routes
//! live in `style.rs`.

use crate::fetcher::{get_tile, FetchOutcome};
use crate::source::ChartSource;
use crate::state::AppState;
use axum::{
    body::{Body, Bytes, HttpBody},
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::task::{Context, Poll};
use tokio::sync::OwnedSemaphorePermit;

/// Build the router. The style routes are added by `crate::style::style_routes`.
pub fn app(state: AppState) -> Router {
    let admission_state = state.clone();
    Router::new()
        .route("/health", get(health))
        .route("/cache/stats", get(stats))
        .route("/config", post(config))
        .route("/cache/scroll-ttl", post(set_scroll_ttl))
        .route("/cache/clear-scroll", post(clear_scroll))
        .route("/cache/regions", get(all_region_bytes_route))
        .route("/tile/{source}/{z}/{x}/{y}", get(tile))
        .route("/warm", post(warm_start))
        .route("/warm/region/{region_id}", get(warm_status_for_region))
        .route("/warm/{job_id}", get(warm_status))
        .route("/warm/{job_id}/cancel", post(warm_cancel))
        .route(
            "/cache/region/{region_id}",
            axum::routing::get(region_bytes_route).delete(delete_region_route),
        )
        .merge(crate::style::style_routes())
        .merge(crate::geocode::geocode_routes())
        .with_state(state)
        .layer(DefaultBodyLimit::max(crate::state::MAX_REQUEST_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            admission_state,
            request_admission,
        ))
}

/// Shed excess work before a handler can enqueue a SQLite blocking task. Health uses a separate,
/// bounded reserve so a tile storm cannot consume every probe slot. The permit spans both the handler
/// and the response body's final frame or drop.
async fn request_admission(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let semaphore = if request.uri().path() == "/health" {
        state.health_request_semaphore.clone()
    } else {
        state.request_semaphore.clone()
    };
    let Ok(permit) = semaphore.try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "1")],
            "tile cache is busy",
        )
            .into_response();
    };
    let response = next.run(request).await;
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(AdmissionBody {
            inner: body,
            _permit: permit,
        }),
    )
}

/// Keep request admission charged through the response body's final frame or drop. This bounds the
/// retained tile bytes for slow or disconnected consumers as well as the handler work itself.
struct AdmissionBody {
    inner: Body,
    _permit: OwnedSemaphorePermit,
}

impl HttpBody for AdmissionBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.get_mut().inner).poll_frame(context)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

pub(crate) const CONTROL_TOKEN_HEADER: &str = "x-tilecache-token";

fn mutation_authorized(state: &AppState, headers: &HeaderMap) -> bool {
    state.control_authorized(
        headers
            .get(CONTROL_TOKEN_HEADER)
            .and_then(|value| value.to_str().ok()),
    )
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

async fn stats(State(st): State<AppState>) -> Response {
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    let r = st.live_regions_budget.load(Ordering::Relaxed);
    let p = st.live_position_warm_budget.load(Ordering::Relaxed);
    let configured = st.configured.load(Ordering::Relaxed);
    // Run the SQLite and filesystem reads on a blocking thread. real_region_pinned_bytes probes
    // region_tiles per pinned tile, so on a large cache it can scan for many seconds; available_bytes
    // also performs a filesystem query. Keeping both off the async runtime stops one stats call from
    // wedging the async reactor. Any database or task failure returns 500 so callers never mistake
    // fabricated zero totals for a healthy empty cache.
    let cache = st.cache.clone();
    let result = tokio::task::spawn_blocking(move || {
        let available_bytes = cache.available_bytes().ok();
        let (rows, bytes, pinned_bytes) = cache.stats()?;
        // The position-warm pseudo-region's pinned bytes, reported as positionWarmBytes.
        let pw = cache.region_bytes(crate::state::POSITION_WARM_REGION_ID)?;
        // The exact real-region pinned bytes: a tile shared between a real region and the position-warm
        // pseudo-region counts once here, so the regions budget gate is not under-counted by subtracting
        // a shared tile fully.
        let real_pinned = cache.real_region_pinned_bytes(crate::state::POSITION_WARM_REGION_ID)?;
        let source_rows = cache.per_source_stats()?;
        let reusable_bytes = cache.reusable_bytes()?;
        Ok::<_, rusqlite::Error>((
            rows,
            bytes,
            pinned_bytes,
            pw,
            real_pinned,
            source_rows,
            reusable_bytes,
            available_bytes,
        ))
    })
    .await;
    let (rows, bytes, pinned_bytes, pw, real_pinned, source_rows, reusable_bytes, available_bytes) =
        match result {
            Ok(Ok(values)) => values,
            Ok(Err(error)) => {
                st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
                eprintln!("event=cache_stats_failed error={error}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            Err(error) => {
                st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
                eprintln!("event=cache_stats_task_failed error={error}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
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
        // Each category is gated against its own logical membership slice. A tile shared between
        // position and a saved region counts in both category figures but only once in physical bytes.
        "regionsFreeBytes": ((r - p) - real_pinned).max(0),
        "perSourceAvgBytes": avg,
        "bySource": by_source,
        "upstream": upstream,
        "configured": configured,
        "availableBytes": available_bytes,
        "sqliteReusableBytes": reusable_bytes,
        "effectiveAvailableBytes": available_bytes.map(|bytes| bytes.saturating_add(reusable_bytes)),
        "minimumHeadroomBytes": crate::cache::MIN_FREE_HEADROOM_BYTES,
        "diskPressure": available_bytes.map(|bytes| bytes < crate::cache::MIN_FREE_HEADROOM_BYTES),
        "diagnostics": {
            "diskPressureEvents": st.cache.disk_pressure_events(),
            "warmRejections": st.warm_rejections.load(Ordering::Relaxed),
            "configPushes": st.config_pushes.load(Ordering::Relaxed),
            "cacheOperationErrors": st.cache.operation_error_events()
                + st.cache_operation_errors.load(Ordering::Relaxed),
        },
    })).into_response()
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
    #[serde(default)]
    geocoding_enabled: Option<bool>,
}

const MAX_CONFIG_SOURCES: usize = 128;

enum CapEnforcement {
    Applied,
    Irreducible { pinned_bytes: i64 },
}

/// Replace the source allowlist (and optionally the public base and the cap and budget knobs) atomically.
///
/// Lowering R (or P) below the currently pinned bytes is the owner's deliberate action and is accepted
/// as-is. Existing pins are not retroactively trimmed; under the soft reserve a region warm only ever
/// evicts unpinned scroll tiles, so the pinned set can sit above the new R until a re-download or a
/// per-region delete converges it. The physical total stays at or below the cap throughout. This is
/// documented and acceptable, not a bug.
async fn config(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ConfigBody>,
) -> Response {
    if !mutation_authorized(&st, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // Serialize the fallback reads as well as publication. Two partial config pushes must derive their
    // omitted fields from one coherent predecessor rather than racing on independently loaded atomics.
    let _config_guard = st.config_update.lock().await;
    let cap = body
        .cap_bytes
        .unwrap_or_else(|| st.live_cap_bytes.load(Ordering::Relaxed));
    let regions = body
        .regions_budget_bytes
        .unwrap_or_else(|| st.live_regions_budget.load(Ordering::Relaxed));
    let position = body
        .position_warm_budget_bytes
        .unwrap_or_else(|| st.live_position_warm_budget.load(Ordering::Relaxed));
    let ttl = body
        .scroll_ttl_secs
        .unwrap_or_else(|| st.live_scroll_ttl_secs.load(Ordering::Relaxed));
    let mut ids = std::collections::HashSet::new();
    let style_source_count = body
        .sources
        .iter()
        .filter(|source| {
            matches!(
                &source.upstream,
                crate::source::UpstreamTemplate::Style { .. }
            )
        })
        .count();
    let invalid_sources = body.sources.len() > MAX_CONFIG_SOURCES
        || style_source_count > crate::style::MAX_LEARNED_STYLE_ENTRIES
        || body.sources.iter().any(|source| {
            !source.is_valid(st.knobs.allow_private_egress) || !ids.insert(source.id.as_str())
        });
    let invalid_public_base = body.public_base.as_ref().is_some_and(|base| {
        !base.starts_with('/')
            || base.starts_with("//")
            || base.len() > 512
            || base.chars().any(|ch| ch.is_control() || ch.is_whitespace())
            || base.contains(['\\', '?', '#'])
    });
    if invalid_sources
        || invalid_public_base
        || cap <= 0
        || regions < 0
        || regions > cap
        || position < 0
        || position > regions
        || !(0..=365 * 86_400).contains(&ttl)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let source_count = body.sources.len();
    // Odd means a replacement is in progress. Generation-aware warm and style work refuses to commit
    // under it; the final increment publishes one coherent even generation. Enforce the physical cap
    // before publishing any in-memory state, so a failed SQLite operation leaves the previous config,
    // configured flag, and success counter intact.
    st.config_generation.fetch_add(1, Ordering::AcqRel);
    let cache = st.cache.clone();
    match tokio::task::spawn_blocking(move || {
        let (_, _, pinned_bytes) = cache.stats()?;
        if pinned_bytes > cap {
            return Ok::<CapEnforcement, rusqlite::Error>(CapEnforcement::Irreducible {
                pinned_bytes,
            });
        }
        cache.evict_to(cap)?;
        cache.reclaim_free_pages()?;
        Ok::<CapEnforcement, rusqlite::Error>(CapEnforcement::Applied)
    })
    .await
    {
        Ok(Ok(CapEnforcement::Applied)) => {}
        Ok(Ok(CapEnforcement::Irreducible { pinned_bytes })) => {
            st.config_generation.fetch_add(1, Ordering::Release);
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "capBelowPinnedBytes",
                    "capBytes": cap,
                    "pinnedBytes": pinned_bytes,
                })),
            )
                .into_response();
        }
        Ok(Err(error)) => {
            st.config_generation.fetch_add(1, Ordering::Release);
            st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("event=config_cap_enforcement_failed error={error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        Err(error) => {
            st.config_generation.fetch_add(1, Ordering::Release);
            st.cache_operation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("event=config_cap_task_failed error={error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    {
        let mut map = st.sources.write().await;
        *map = body
            .sources
            .into_iter()
            .map(|source| (source.id.clone(), source))
            .collect();
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
    if let Some(enabled) = body.geocoding_enabled {
        st.geocoding_enabled.store(enabled, Ordering::Release);
    }
    st.config_generation.fetch_add(1, Ordering::Release);
    st.configured.store(true, Ordering::Relaxed);
    st.config_pushes.fetch_add(1, Ordering::Relaxed);
    eprintln!("event=config_push_applied sources={source_count}");
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrollTtlBody {
    ttl_secs: i64,
}

/// POST /cache/scroll-ttl: set only the live scroll TTL. A dedicated route so a live TTL edit does
/// not re-push the source allowlist or clear the learned style state, which POST /config does.
async fn set_scroll_ttl(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ScrollTtlBody>,
) -> StatusCode {
    if !mutation_authorized(&st, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    if !(0..=365 * 86_400).contains(&body.ttl_secs) {
        return StatusCode::BAD_REQUEST;
    }
    st.live_scroll_ttl_secs
        .store(body.ttl_secs, Ordering::Relaxed);
    StatusCode::NO_CONTENT
}

/// POST /cache/clear-scroll: delete every unpinned scroll tile, keeping pinned region and
/// position-warm tiles. Runs on a blocking thread because the chunked delete is synchronous.
async fn clear_scroll(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if !mutation_authorized(&st, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
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
    if !crate::warm::valid_region_id(&region_id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
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
    headers: HeaderMap,
) -> StatusCode {
    if !mutation_authorized(&st, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    // The reserved pseudo-regions (position-warm and basemap assets) are managed by the warm engine, not
    // by the region API, so refuse to let a caller unpin them out from under it.
    if !crate::warm::valid_region_id(&region_id)
        || region_id == crate::state::POSITION_WARM_REGION_ID
        || region_id == crate::state::BASEMAP_ASSETS_REGION_ID
    {
        return StatusCode::FORBIDDEN;
    }
    if !crate::warm::cancel_region_warms(&st, &region_id).await {
        eprintln!("event=region_delete_cancel_timeout region_id={region_id}");
        return StatusCode::CONFLICT;
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
        FetchOutcome::NotModified { etag, stale } => {
            crate::response::tile_http_response("", &etag, stale, bytes::Bytes::new(), Some(&etag))
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
// allowlist and expands style sources from their validated learned templates. The placeholder
// fields beyond `id` are unused after resolution.
async fn warm_start(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WarmBody>,
) -> Response {
    if !mutation_authorized(&st, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if body.sources.is_empty() || body.sources.len() > crate::warm::MAX_WARM_SOURCES {
        return StatusCode::BAD_REQUEST.into_response();
    }
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
            coverage: None,
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
        Err(crate::warm::StartError::MultipleStyleSources) => (
            StatusCode::BAD_REQUEST,
            "a warm request may select at most one style source",
        )
            .into_response(),
        Err(crate::warm::StartError::RegionBusy) => {
            st.warm_rejections.fetch_add(1, Ordering::Relaxed);
            eprintln!("event=warm_rejected reason=region_busy");
            StatusCode::CONFLICT.into_response()
        }
        Err(crate::warm::StartError::BadRegion(message)) => {
            st.warm_rejections.fetch_add(1, Ordering::Relaxed);
            (StatusCode::BAD_REQUEST, message).into_response()
        }
        Err(crate::warm::StartError::ShuttingDown) => {
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

async fn warm_status(State(st): State<AppState>, Path(job_id): Path<String>) -> Response {
    if !crate::warm::valid_job_id(&job_id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match crate::warm::warm_snapshot(&st, &job_id).await {
        Some(snap) => Json(snap).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn warm_status_for_region(
    State(st): State<AppState>,
    Path(region_id): Path<String>,
) -> Response {
    if !crate::warm::valid_region_id(&region_id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match crate::warm::warm_snapshot_for_region(&st, &region_id).await {
        Some(snapshot) => Json(snapshot).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn warm_cancel(
    State(st): State<AppState>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !mutation_authorized(&st, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !crate::warm::valid_job_id(&job_id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if crate::warm::cancel_warm(&st, &job_id).await {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::{CachedTile, TileCache, TileKey};
    use crate::state::Knobs;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use bytes::Bytes;
    use http_body_util::BodyExt;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::NamedTempFile;
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    const TEST_CONTROL_TOKEN: &str = "test-control-token";

    struct Request;

    impl Request {
        fn get(uri: impl AsRef<str>) -> axum::http::request::Builder {
            HttpRequest::get(uri.as_ref())
        }

        fn post(uri: impl AsRef<str>) -> axum::http::request::Builder {
            HttpRequest::post(uri.as_ref()).header(CONTROL_TOKEN_HEADER, TEST_CONTROL_TOKEN)
        }
    }

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
        let mut state = AppState::new(
            cache,
            Knobs {
                allow_private_egress: true,
                ..Default::default()
            },
        );
        state.control_token = Some(Arc::from(TEST_CONTROL_TOKEN));
        state
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
    async fn request_admission_sheds_excess_work_but_reserves_health_capacity() {
        let db = NamedTempFile::new().unwrap();
        let mut state = dev_state(&db);
        state.request_semaphore = Arc::new(tokio::sync::Semaphore::new(1));
        state.health_request_semaphore = Arc::new(tokio::sync::Semaphore::new(1));
        let router = app(state);

        // Keep the first ordinary response body unread. Its admission permit must remain charged after
        // the handler returns, or slow consumers could retain unbounded cached tile bodies.
        let ordinary = router
            .clone()
            .oneshot(Request::get("/cache/regions").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(ordinary.status(), StatusCode::OK);

        let overloaded = router
            .clone()
            .oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(overloaded.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(overloaded.headers().get(header::RETRY_AFTER).unwrap(), "1");

        // General saturation does not consume the dedicated health reserve, but the same body-lifetime
        // rule applies within that reserve.
        let health = router
            .clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let overloaded_health = router
            .clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(overloaded_health.status(), StatusCode::SERVICE_UNAVAILABLE);

        ordinary.into_body().collect().await.unwrap();
        health.into_body().collect().await.unwrap();
        let recovered = router
            .clone()
            .oneshot(Request::get("/cache/regions").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(recovered.status(), StatusCode::OK);
        let recovered_health = router
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(recovered_health.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn control_json_body_is_rejected_above_the_memory_budget_cap() {
        let db = NamedTempFile::new().unwrap();
        let response = app(dev_state(&db))
            .oneshot(
                Request::post("/config")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(vec![
                        b' ';
                        crate::state::MAX_REQUEST_BODY_BYTES + 1
                    ]))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn control_token_protects_mutations_but_not_read_routes() {
        let db = NamedTempFile::new().unwrap();
        let mut state = dev_state(&db);
        state.control_token = Some(Arc::from("correct-token"));
        let router = app(state.clone());

        let health = router
            .clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            health.status(),
            StatusCode::OK,
            "read routes do not require the mutation token",
        );

        for token in [None, Some("wrong-token")] {
            let mut request =
                HttpRequest::post("/config").header("content-type", "application/json");
            if let Some(token) = token {
                request = request.header(CONTROL_TOKEN_HEADER, token);
            }
            let response = router
                .clone()
                .oneshot(request.body(Body::from(r#"{"sources":[]}"#)).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        let accepted = router
            .clone()
            .oneshot(
                HttpRequest::post("/config")
                    .header("content-type", "application/json")
                    .header(CONTROL_TOKEN_HEADER, "correct-token")
                    .body(Body::from(r#"{"sources":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::NO_CONTENT);

        let unprotected_clear = router
            .clone()
            .oneshot(
                HttpRequest::post("/cache/clear-scroll")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unprotected_clear.status(), StatusCode::UNAUTHORIZED);
        let protected_clear = router
            .oneshot(
                HttpRequest::post("/cache/clear-scroll")
                    .header(CONTROL_TOKEN_HEADER, "correct-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(protected_clear.status(), StatusCode::OK);

        let mut missing_state = dev_state(&db);
        missing_state.control_token = None;
        let missing = app(missing_state)
            .oneshot(
                HttpRequest::post("/config")
                    .header("content-type", "application/json")
                    .header(CONTROL_TOKEN_HEADER, "correct-token")
                    .body(Body::from(r#"{"sources":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            missing.status(),
            StatusCode::UNAUTHORIZED,
            "a missing server-side token fails closed",
        );
    }

    #[tokio::test]
    async fn config_caps_source_count_and_controls_geocoding() {
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let router = app(state.clone());
        let sources: Vec<_> = (0..=MAX_CONFIG_SOURCES)
            .map(|index| {
                serde_json::json!({
                    "id": format!("s{index}"),
                    "title": "S",
                    "tileSize": 256,
                    "minzoom": 0,
                    "maxzoom": 1,
                    "attribution": "",
                    "upstream": {
                        "mode": "xyz",
                        "urlTemplate": "http://127.0.0.1/t/{z}/{x}/{y}"
                    }
                })
            })
            .collect();
        let too_many = router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "sources": sources }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(too_many.status(), StatusCode::BAD_REQUEST);
        assert!(state.sources.read().await.is_empty());

        let disable = router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"sources":[],"geocodingEnabled":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(disable.status(), StatusCode::NO_CONTENT);
        assert!(!state.geocoding_enabled.load(Ordering::Acquire));
        let geocode = router
            .oneshot(
                Request::get("/geocode?lat=1&lon=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(geocode.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn warm_route_rejects_more_than_the_source_limit_before_resolution() {
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        let sources: Vec<String> = (0..=crate::warm::MAX_WARM_SOURCES)
            .map(|index| format!("s{index}"))
            .collect();
        let response = router
            .oneshot(
                Request::post("/warm")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "sources": sources,
                            "bbox": [-1.0, -1.0, 1.0, 1.0],
                            "minzoom": 0,
                            "maxzoom": 0
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn config_rejects_invalid_sources_and_budget_relationships_without_mutating_state() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let router = app(state.clone());
        let valid = router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(valid.status(), StatusCode::NO_CONTENT);

        let invalid_source = r#"{"sources":[{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"","upstream":{"mode":"xyz","urlTemplate":"file:///tmp/{z}/{x}/{y}"}}}]}"#.to_string();
        let invalid = [
            r#"{"sources":[],"capBytes":0}"#.to_string(),
            r#"{"sources":[],"capBytes":100,"regionsBudgetBytes":101}"#.to_string(),
            r#"{"sources":[],"capBytes":100,"regionsBudgetBytes":90,"positionWarmBudgetBytes":91}"#
                .to_string(),
            r#"{"sources":[],"scrollTtlSecs":-1}"#.to_string(),
            r#"{"sources":[],"publicBase":"https://example.test/plugins/p"}"#.to_string(),
            invalid_source,
        ];
        for body in invalid {
            let response = router
                .clone()
                .oneshot(
                    Request::post("/config")
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        assert_eq!(state.config_pushes.load(Ordering::Relaxed), 1);
        assert!(state.sources.read().await.contains_key("s"));
    }

    #[tokio::test]
    async fn a_failed_cap_eviction_does_not_publish_the_candidate_config() {
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let now = crate::state::now_secs();
        state
            .cache
            .put(
                TileKey::new("existing", 0, 0, 0),
                &CachedTile {
                    content_type: "image/png".into(),
                    strong_etag: "\"existing\"".into(),
                    upstream_validator: None,
                    status: 200,
                    fetched_at: now,
                    last_access: now,
                    bytes: 4,
                    blob: Some(Bytes::from_static(&[1, 2, 3, 4])),
                },
                false,
                now,
            )
            .unwrap();
        let original_cap = state.live_cap_bytes.load(Ordering::Relaxed);
        state.cache.set_query_only_for_test();

        let response = app(state.clone())
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"sources":[],"capBytes":1}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!state.configured.load(Ordering::Relaxed));
        assert_eq!(state.config_pushes.load(Ordering::Relaxed), 0);
        assert_eq!(state.live_cap_bytes.load(Ordering::Relaxed), original_cap);
        assert!(state.sources.read().await.is_empty());
        assert!(state
            .config_generation
            .load(Ordering::Acquire)
            .is_multiple_of(2));
        assert!(
            state
                .cache
                .get(TileKey::new("existing", 0, 0, 0))
                .unwrap()
                .is_some(),
            "the failed eviction transaction leaves the previous cache row intact"
        );
    }

    #[tokio::test]
    async fn a_cap_below_pinned_bytes_is_rejected_and_region_deletion_allows_retry() {
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let now = crate::state::now_secs();
        let key = TileKey::new("existing", 0, 0, 0);
        state
            .cache
            .put(
                key,
                &CachedTile {
                    content_type: "image/png".into(),
                    strong_etag: "\"existing\"".into(),
                    upstream_validator: None,
                    status: 200,
                    fetched_at: now,
                    last_access: now,
                    bytes: 4,
                    blob: Some(Bytes::from_static(&[1, 2, 3, 4])),
                },
                false,
                now,
            )
            .unwrap();
        assert!(state
            .cache
            .pin_for_region(key, i64::MAX, Some("r1"))
            .unwrap());
        let original_cap = state.live_cap_bytes.load(Ordering::Relaxed);
        let router = app(state.clone());

        let rejected = router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"sources":[],"capBytes":3}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_string(rejected).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body.contains("\"error\":\"capBelowPinnedBytes\""));
        assert!(body.contains("\"pinnedBytes\":4"));
        assert!(!state.configured.load(Ordering::Relaxed));
        assert_eq!(state.config_pushes.load(Ordering::Relaxed), 0);
        assert_eq!(state.live_cap_bytes.load(Ordering::Relaxed), original_cap);

        // Recovery routes remain usable even though the first config has not been accepted.
        let stats = router
            .clone()
            .oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(stats.status(), StatusCode::OK);
        let deleted = router
            .clone()
            .oneshot(
                HttpRequest::delete("/cache/region/r1")
                    .header(CONTROL_TOKEN_HEADER, TEST_CONTROL_TOKEN)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);

        let accepted = router
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"sources":[],"capBytes":3}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::NO_CONTENT);
        assert!(state.configured.load(Ordering::Relaxed));
        assert_eq!(state.live_cap_bytes.load(Ordering::Relaxed), 3);
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
        // Equal west and east has zero area and triggers BadBbox. West greater than east is a valid
        // antimeridian-crossing box.
        let bad_bbox = router
            .clone()
            .oneshot(
                Request::post("/warm")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"sources":["s"],"bbox":[10.0,-1.0,10.0,1.0],"minzoom":0,"maxzoom":0}"#,
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
    async fn region_and_warm_status_routes_reject_malformed_identifiers() {
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        for uri in [
            "/cache/region/bad%20region",
            "/warm/region/bad%20region",
            "/warm/not-a-generated-job-id",
        ] {
            let response = router
                .clone()
                .oneshot(Request::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
        }
        let cancel = router
            .clone()
            .oneshot(
                Request::post("/warm/not-a-generated-job-id/cancel")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancel.status(), StatusCode::BAD_REQUEST);

        let unknown_but_well_formed = router
            .oneshot(
                Request::get("/warm/warm-00000000000000000000000000000000-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown_but_well_formed.status(), StatusCode::NOT_FOUND);
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
            .oneshot(
                Request::get("/warm/warm-00000000000000000000000000000000-1")
                    .body(Body::empty())
                    .unwrap(),
            )
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
