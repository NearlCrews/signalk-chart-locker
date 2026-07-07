//! The read-through fetch path: serve a cached tile, revalidate a stale one when online, serve stale
//! when offline, fetch and store a miss, negative-cache a 404 or 204, and coalesce duplicate misses.
//! The egress is allowlist-keyed by source id, redirects are off (the client), and every upstream IP
//! is checked before connecting.

use crate::cache::{CachedTile, TileKey};
use crate::source::UpstreamTemplate;
use crate::state::{now_secs, AppState, FetchError};
use crate::upstream::expand_upstream;
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;
use std::time::Duration;

/// A fetched upstream body and its metadata, bundled so the store path takes few arguments.
pub(crate) struct Fetched {
    pub(crate) content_type: String,
    pub(crate) validator: Option<String>,
    pub(crate) body: Bytes,
}

/// A tile ready to serve.
pub struct TileResponse {
    pub status: u16,
    pub content_type: String,
    pub etag: String,
    pub stale: bool,
    pub body: Bytes,
}

/// The outcome of a tile request, mapped to HTTP by the route layer.
pub enum FetchOutcome {
    Hit(TileResponse),
    NotModified {
        etag: String,
    },
    /// A negatively cached or upstream sparse-coverage response (status without a body).
    Empty {
        status: u16,
    },
    /// Unknown source, or a style source asked for as a tile.
    NotAllowed,
    BadRequest(String),
    /// Offline (or a bad upstream) and nothing cacheable to serve.
    Unavailable,
}

pub(crate) fn acceptable_content_type(ct: &str) -> bool {
    let ct = ct.to_ascii_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("application/x-protobuf")
        || ct.starts_with("application/vnd.mapbox-vector-tile")
}

/// At most one last_access write per tile per hour, so a pan does not turn every warm-tile read into a
/// microSD write while the LRU still tracks roughly-recent use.
pub(crate) const TOUCH_THROTTLE_SECS: i64 = 3600;

/// The strong content-address ETag served to the browser. Shared with the style proxy so the two
/// content-address minters cannot diverge.
pub(crate) fn strong_etag(body: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut h = Sha256::new();
    h.update(body);
    let digest = h.finalize();
    let mut etag = String::with_capacity(digest.len() * 2 + 2);
    etag.push('"');
    for byte in &digest {
        etag.push(HEX[(byte >> 4) as usize] as char);
        etag.push(HEX[(byte & 0xf) as usize] as char);
    }
    etag.push('"');
    etag
}

/// Log a cache write that failed for a reason other than a graceful disk-full degrade, so a real DB
/// fault (locking, corruption) is visible in the container logs instead of silently dropped.
pub(crate) fn log_cache_err<T>(result: rusqlite::Result<T>) {
    if let Err(e) = result {
        eprintln!("tilecache: cache write failed: {e}");
    }
}

/// Run a cache write off the reactor on the blocking pool, so a SQLite write never stalls an async
/// worker alongside live tile reads. When `detached`, the JoinHandle is dropped so a best-effort write
/// (the LRU touch) runs without delaying the caller; otherwise the caller awaits it and a task-join
/// failure is logged under `label`.
async fn run_cache_write(label: &str, detached: bool, f: impl FnOnce() + Send + 'static) {
    let handle = tokio::task::spawn_blocking(f);
    if detached {
        return;
    }
    if let Err(e) = handle.await {
        eprintln!("tilecache: {label} task failed: {e}");
    }
}

/// The single-flight key for a tile, shared by `fill` and `get_tile` so the stale-while-revalidate
/// spawn guard keys on exactly the string `fill` registers under.
fn inflight_key(source_id: &str, z: u32, x: u32, y: u32) -> String {
    format!("{source_id}/{z}/{x}/{y}")
}

fn to_response(tile: &CachedTile, stale: bool) -> TileResponse {
    TileResponse {
        status: tile.status as u16,
        content_type: tile.content_type.clone(),
        etag: tile.strong_etag.clone(),
        stale,
        body: tile.blob.clone().unwrap_or_default(),
    }
}

/// Serve a cached 200: a matching If-None-Match answers NotModified, anything else the body.
/// One owner for the choice so a conditional-request change cannot drift across the serve sites.
fn respond_cached(tile: &CachedTile, if_none_match: Option<&str>, stale: bool) -> FetchOutcome {
    if if_none_match == Some(tile.strong_etag.as_str()) {
        FetchOutcome::NotModified {
            etag: tile.strong_etag.clone(),
        }
    } else {
        FetchOutcome::Hit(to_response(tile, stale))
    }
}

/// Fetch the upstream at the source's adaptive timeout, returning (status, fetched) or a `FetchError`.
/// The per-source `UpstreamHealth` schedule sets the timeout: a timed-out fetch escalates the source and
/// is retried exactly once at the (now higher) timeout, so a source that swings from responsive to slow
/// still fills the cache on the second attempt; a transport error (a refused connection is offline) is
/// returned without a retry, because retrying only delays serving stale. A response whose body reads
/// fully, of any status including a fast 404, records success and can recover the source, recorded after
/// the read so a header-fast but body-stalled upstream is not credited responsive. SSRF is enforced by
/// guarded_get (the literal-IP guard plus the client's guarded DNS resolver), and the body is read under
/// a streaming size cap, so a decompression or chunked bomb cannot be read unbounded into memory.
pub(crate) async fn fetch_upstream(
    state: &AppState,
    source_id: &str,
    url: &str,
    if_none_match: Option<&str>,
) -> Result<(u16, Fetched), FetchError> {
    let mut retried = false;
    loop {
        let timeout = Duration::from_millis(state.upstream_health.timeout_ms(source_id));
        match state.guarded_get(url, if_none_match, Some(timeout)).await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let content_type = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let validator = resp
                    .headers()
                    .get(reqwest::header::ETAG)
                    .or_else(|| resp.headers().get(reqwest::header::LAST_MODIFIED))
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                // A body-read failure (including a mid-body stall on a degraded upstream) maps to
                // Transport. For a slow WMS the stall is before headers, so classifying the rare mid-body
                // failure as Transport rather than Timeout is acceptable and never negative-caches.
                let body = state.read_capped(resp).await.ok_or(FetchError::Transport)?;
                // Record success only after the body reads fully, so a header-fast but body-stalled
                // upstream is not credited responsive and cannot keep the source marked healthy.
                state.upstream_health.record_success(source_id, now_secs());
                return Ok((
                    status,
                    Fetched {
                        content_type,
                        validator,
                        body,
                    },
                ));
            }
            Err(FetchError::Timeout) => {
                state.upstream_health.record_timeout(source_id, now_secs());
                if retried {
                    return Err(FetchError::Timeout);
                }
                retried = true;
            }
            Err(FetchError::Transport) => return Err(FetchError::Transport),
        }
    }
}

/// Store a fetched 200 and return it, or negative-cache a 404 or 204. Rejects an oversize body or a
/// non-image content type (a WMS XML ServiceException returned with a 200) without storing.
async fn store_200(
    state: &AppState,
    source_id: &str,
    z: u32,
    x: u32,
    y: u32,
    fetched: Fetched,
    if_none_match: Option<&str>,
) -> FetchOutcome {
    if fetched.body.len() > state.knobs.max_blob_bytes
        || !acceptable_content_type(&fetched.content_type)
    {
        return FetchOutcome::Unavailable;
    }
    let now = now_secs();
    let etag = strong_etag(&fetched.body);
    let tile = CachedTile {
        content_type: fetched.content_type.clone(),
        strong_etag: etag.clone(),
        upstream_validator: fetched.validator,
        status: 200,
        fetched_at: now,
        last_access: now,
        bytes: fetched.body.len() as i64,
        blob: Some(fetched.body.clone()),
    };
    // Store and evict on the blocking pool: once the cache sits at the cap, evict_to runs a window-function
    // scan over the unpinned rows, so keeping it off the async reactor stops a steady-state
    // miss-store from stalling live tile reads. Soft reserve: evict_to(cap) drops only unpinned rows, so the
    // scroll cache fills the cap minus the bytes actually pinned by saved regions (the full cap when nothing
    // is pinned).
    let cache = state.cache.clone();
    let cap = state.live_cap_bytes.load(Ordering::Relaxed);
    let source_owned = source_id.to_string();
    run_cache_write("tile store", false, move || {
        log_cache_err(cache.put(TileKey::new(&source_owned, z, x, y), &tile, false, now));
        log_cache_err(cache.evict_to(cap));
    })
    .await;
    if if_none_match == Some(etag.as_str()) {
        return FetchOutcome::NotModified { etag };
    }
    FetchOutcome::Hit(TileResponse {
        status: 200,
        content_type: fetched.content_type,
        etag,
        stale: false,
        body: fetched.body,
    })
}

async fn negative_cache(
    state: &AppState,
    source_id: &str,
    z: u32,
    x: u32,
    y: u32,
    status: u16,
) -> FetchOutcome {
    let now = now_secs();
    let tile = CachedTile::negative(status as i64, now);
    let cache = state.cache.clone();
    let source_owned = source_id.to_string();
    run_cache_write("negative-cache store", false, move || {
        log_cache_err(cache.put(TileKey::new(&source_owned, z, x, y), &tile, false, now))
    })
    .await;
    FetchOutcome::Empty { status }
}

/// Serve a tile: cache-first, with revalidation, negative cache, serve-stale, and single-flight. A fresh
/// hit, a fresh negative, and a not-modified response are served inline. Everything that needs an upstream
/// fetch (a miss, an expired negative, or a stale tile) is handled by a spawned `fill` task, so a browser
/// or plugin-proxy disconnect that drops this handler cannot cancel the fetch. For a source the health
/// tracker marks slow, a stale tile is served immediately while `fill` revalidates in the background
/// (stale-while-revalidate); otherwise the handler awaits the fill so the revalidation outcome is observed
/// inline as before.
pub async fn get_tile(
    state: &AppState,
    source_id: &str,
    z: u32,
    x: u32,
    y: u32,
    if_none_match: Option<String>,
) -> FetchOutcome {
    let source = {
        let map = state.sources.read().await;
        match map.get(source_id) {
            Some(s) => s.clone(),
            None => return FetchOutcome::NotAllowed,
        }
    };
    if matches!(source.upstream, UpstreamTemplate::Style { .. }) {
        return FetchOutcome::NotAllowed;
    }
    let url = match expand_upstream(&source, z, x, y) {
        Ok(u) => u,
        Err(e) => return FetchOutcome::BadRequest(e.0),
    };
    let now = now_secs();

    // Cache-first: the paths served inline (no upstream fetch, so no spawn).
    if let Ok(Some(tile)) = state.cache.get(TileKey::new(source_id, z, x, y)) {
        if tile.status != 200 {
            if now - tile.fetched_at < state.knobs.negative_ttl_secs {
                return FetchOutcome::Empty {
                    status: tile.status as u16,
                };
            }
            // An expired negative falls through to a fresh fill.
        } else if now - tile.fetched_at < state.knobs.fresh_secs {
            // Throttle the LRU write so a pan does not write to the microSD on every warm-tile read, and
            // run it detached on the blocking pool so the best-effort last_access bump never delays the
            // cache hit or blocks the reactor on a SQLite write.
            if now - tile.last_access >= TOUCH_THROTTLE_SECS {
                let cache = state.cache.clone();
                let source_owned = source_id.to_string();
                run_cache_write("touch", true, move || {
                    log_cache_err(cache.touch(TileKey::new(&source_owned, z, x, y), now))
                })
                .await;
            }
            return respond_cached(&tile, if_none_match.as_deref(), false);
        } else if state.upstream_health.is_slow(source_id)
            && now - tile.fetched_at < state.knobs.max_stale_secs
        {
            // Stale-while-revalidate for a slow source: serve the stale tile now and revalidate in the
            // background, so a pan does not block on a multi-second revalidation. Spawn at most one fill
            // per hot key: a failed revalidation stores nothing, so without the guard each queued stale
            // read refetches at the escalated timeout while holding an egress permit, and the tasks pile
            // up. The tiny race where a second read spawns before the first fill registers the key is
            // bounded, because the tasks serialize on the single-flight lock. The detached task outlives
            // this handler, so a client disconnect cannot cancel it.
            let key = inflight_key(source_id, z, x, y);
            if !state.inflight_contains(&key).await {
                spawn_fill(state, source_id, z, x, y, url, if_none_match.clone());
            }
            // A matching validator answers 304 with the stale etag rather than shipping the stale body.
            return respond_cached(&tile, if_none_match.as_deref(), true);
        }
        // A stale tile on a source that is not slow (or one past the stale bound) falls through to an
        // awaited fill, so the revalidation and its 304 or 200 outcome are observed inline.
    }

    fill_and_await(state, source_id, z, x, y, url, if_none_match).await
}

/// Spawn a detached `fill` task, so a browser or proxy disconnect that drops the caller cannot cancel
/// the fetch. Shared by the miss path (awaited) and the slow-stale path (fire and forget).
fn spawn_fill(
    state: &AppState,
    source_id: &str,
    z: u32,
    x: u32,
    y: u32,
    url: String,
    if_none_match: Option<String>,
) -> tokio::task::JoinHandle<FetchOutcome> {
    tokio::spawn(fill(
        state.clone(),
        source_id.to_string(),
        z,
        x,
        y,
        url,
        if_none_match,
    ))
}

/// Spawn a `fill` and await its outcome, mapping a task-join failure to Unavailable. Used for the miss
/// and the not-slow stale paths, where the handler serves the fill's result.
async fn fill_and_await(
    state: &AppState,
    source_id: &str,
    z: u32,
    x: u32,
    y: u32,
    url: String,
    if_none_match: Option<String>,
) -> FetchOutcome {
    match spawn_fill(state, source_id, z, x, y, url, if_none_match).await {
        Ok(outcome) => outcome,
        Err(e) => {
            eprintln!("tilecache: fill task failed: {e}");
            FetchOutcome::Unavailable
        }
    }
}

/// The detached fill: take the single-flight lock, re-check the cache so losers coalesce onto the
/// winner's stored tile, then revalidate a stale row or fetch a miss and store the result. `get_tile`
/// spawns this so a browser or proxy disconnect cannot cancel the fetch: the task runs to completion and
/// stores the tile, and the next request serves it from cache, so blank areas self-heal. One function
/// serves both the miss and the stale-revalidation path, so revalidation is single-flight coalesced too.
async fn fill(
    state: AppState,
    source_id: String,
    z: u32,
    x: u32,
    y: u32,
    url: String,
    if_none_match: Option<String>,
) -> FetchOutcome {
    let key = inflight_key(&source_id, z, x, y);
    let lock = state.inflight_lock(&key).await;
    let _guard = lock.lock().await;
    let now = now_secs();
    // Re-check under the lock: the winning flight may have filled the cache while we waited. Losers
    // coalesce onto a fresh 200 or a fresh negative here and never refetch.
    let existing = state
        .cache
        .get(TileKey::new(&source_id, z, x, y))
        .ok()
        .flatten();
    if let Some(tile) = &existing {
        if tile.status == 200 && now - tile.fetched_at < state.knobs.fresh_secs {
            state.inflight_finish(&key, &lock).await;
            return respond_cached(tile, if_none_match.as_deref(), false);
        }
        if tile.status != 200 && now - tile.fetched_at < state.knobs.negative_ttl_secs {
            state.inflight_finish(&key, &lock).await;
            return FetchOutcome::Empty {
                status: tile.status as u16,
            };
        }
    }
    let outcome = if let Some(tile) = existing.filter(|t| t.status == 200) {
        // A stale 200: revalidate with the stored validator, else serve stale within the max-stale bound.
        match fetch_upstream(&state, &source_id, &url, tile.upstream_validator.as_deref()).await {
            Ok((304, _)) => {
                let mut refreshed = tile.clone();
                refreshed.fetched_at = now;
                refreshed.last_access = now;
                // Off the reactor like store_200: the freshness-bump write is a SQLite write.
                let cache = state.cache.clone();
                let source_owned = source_id.clone();
                run_cache_write("revalidation refresh", false, move || {
                    log_cache_err(cache.put(
                        TileKey::new(&source_owned, z, x, y),
                        &refreshed,
                        false,
                        now,
                    ))
                })
                .await;
                respond_cached(&tile, if_none_match.as_deref(), false)
            }
            Ok((200, fetched)) => {
                store_200(
                    &state,
                    &source_id,
                    z,
                    x,
                    y,
                    fetched,
                    if_none_match.as_deref(),
                )
                .await
            }
            // A failed revalidation, including a 404 (which does not negative-cache a live tile), serves
            // the stale tile while it is within the max-stale bound.
            _ => {
                if now - tile.fetched_at < state.knobs.max_stale_secs {
                    FetchOutcome::Hit(to_response(&tile, true))
                } else {
                    FetchOutcome::Unavailable
                }
            }
        }
    } else {
        // A miss or an expired negative: fetch fresh, storing a 200 or negative-caching a 404 or 204.
        match fetch_upstream(&state, &source_id, &url, None).await {
            Ok((200, fetched)) => {
                store_200(
                    &state,
                    &source_id,
                    z,
                    x,
                    y,
                    fetched,
                    if_none_match.as_deref(),
                )
                .await
            }
            Ok((status @ (404 | 204), _)) => {
                negative_cache(&state, &source_id, z, x, y, status).await
            }
            Ok(_) => FetchOutcome::Unavailable,
            Err(_) => {
                // Offline or timed out: serve any cached 200 within the max-stale bound. The single-flight
                // lock does not cover the warm engine's batch flush, so a concurrent region or position warm
                // can have stored a 200 for this key since the re-check.
                match state.cache.get(TileKey::new(&source_id, z, x, y)) {
                    Ok(Some(tile))
                        if tile.status == 200
                            && now_secs() - tile.fetched_at < state.knobs.max_stale_secs =>
                    {
                        FetchOutcome::Hit(to_response(&tile, true))
                    }
                    _ => FetchOutcome::Unavailable,
                }
            }
        }
    };
    state.inflight_finish(&key, &lock).await;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::TileCache;
    use crate::source::{ChartSource, UpstreamTemplate};
    use crate::state::Knobs;
    use axum::http::{header, StatusCode};
    use axum::{routing::get, Router};
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::NamedTempFile;
    use tokio::net::TcpListener;

    #[test]
    fn strong_etag_is_a_quoted_64_char_lowercase_hex_digest() {
        // Known SHA-256 vectors, so the content-address ETag stays byte-identical across the sha2
        // bump (digest output moved to a hybrid-array type with no LowerHex, forcing manual hex).
        assert_eq!(
            strong_etag(b""),
            "\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\""
        );
        let etag = strong_etag(b"abc");
        assert_eq!(
            etag,
            "\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\""
        );
        assert_eq!(etag.len(), 66);
        let inner = &etag[1..etag.len() - 1];
        assert_eq!(inner.len(), 64);
        assert!(inner
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    // Bind an ephemeral loopback port, serve the router in the background, and pause briefly so the
    // listener is accepting before the first request.
    async fn serve_router(app: Router) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    async fn spawn_stub(hits: Arc<AtomicUsize>) -> SocketAddr {
        let h = hits.clone();
        let app = Router::new()
            .route(
                "/img/{z}/{x}/{y}",
                get(move || {
                    let h = h.clone();
                    async move {
                        h.fetch_add(1, Ordering::SeqCst);
                        ([(header::CONTENT_TYPE, "image/png")], vec![1u8, 2, 3, 4])
                    }
                }),
            )
            .route(
                "/xml",
                get(|| async { ([(header::CONTENT_TYPE, "text/xml")], "<ServiceException/>") }),
            )
            .route("/missing", get(|| async { StatusCode::NOT_FOUND }));
        serve_router(app).await
    }

    fn xyz_source(url_template: String) -> ChartSource {
        ChartSource {
            id: "s".into(),
            title: "S".into(),
            upstream: UpstreamTemplate::Xyz { url_template },
            tile_size: 256,
            minzoom: 0,
            maxzoom: 18,
            vector_maxzoom: None,
            bounds: None,
            attribution: String::new(),
        }
    }

    async fn state_with(db: &NamedTempFile, knobs: Knobs, source: ChartSource) -> AppState {
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let st = AppState::new(cache, knobs);
        st.sources.write().await.insert(source.id.clone(), source);
        st
    }

    fn dev_knobs() -> Knobs {
        Knobs {
            allow_private_egress: true,
            ..Default::default()
        }
    }

    // Prime a stored 200 for s/1/0/0 with strong etag "e" and mark the source slow (a recorded timeout),
    // so the next read serves the stale tile while a background fill revalidates.
    fn prime_stale_slow_tile(st: &AppState) {
        let now = now_secs();
        st.cache
            .put(
                TileKey::new("s", 1, 0, 0),
                &CachedTile {
                    content_type: "image/png".into(),
                    strong_etag: "e".into(),
                    upstream_validator: None,
                    status: 200,
                    fetched_at: now,
                    last_access: now,
                    bytes: 4,
                    blob: Some(vec![1u8, 2, 3, 4].into()),
                },
                false,
                now,
            )
            .unwrap();
        st.upstream_health.record_timeout("s", now);
    }

    // A stub whose per-hit latency is driven by a hit counter: the first `slow_hits` hits sleep `slow`
    // before answering, later hits answer instantly. Keying behavior on the counter (not on wall time)
    // keeps the timing tests off a thin sleep-versus-timeout margin on a loaded Pi.
    async fn spawn_counting_stub(
        hits: Arc<AtomicUsize>,
        slow_hits: usize,
        slow: std::time::Duration,
    ) -> SocketAddr {
        let h = hits.clone();
        let app = Router::new().route(
            "/img/{z}/{x}/{y}",
            get(move || {
                let h = h.clone();
                async move {
                    // fetch_add returns the pre-increment count, so hit indices 0..slow_hits sleep.
                    let n = h.fetch_add(1, Ordering::SeqCst);
                    if n < slow_hits {
                        tokio::time::sleep(slow).await;
                    }
                    ([(header::CONTENT_TYPE, "image/png")], vec![1u8, 2, 3, 4])
                }
            }),
        );
        serve_router(app).await
    }

    // A 100ms base timeout, so a 1 second stub sleep is a forced timeout with 10x headroom.
    fn fast_timeout_knobs() -> Knobs {
        Knobs {
            upstream_base_timeout_ms: 100,
            ..dev_knobs()
        }
    }

    #[tokio::test]
    async fn fetches_caches_and_coalesces_duplicate_misses() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits.clone()).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(
            &db,
            dev_knobs(),
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;

        let (a, b) = tokio::join!(
            get_tile(&st, "s", 1, 0, 0, None),
            get_tile(&st, "s", 1, 0, 0, None)
        );
        assert!(matches!(a, FetchOutcome::Hit(_)));
        assert!(matches!(b, FetchOutcome::Hit(_)));
        let c = get_tile(&st, "s", 1, 0, 0, None).await;
        assert!(matches!(c, FetchOutcome::Hit(_)));
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "single-flight and the cache mean one upstream fetch"
        );
    }

    #[tokio::test]
    async fn rejects_a_non_image_200_and_does_not_store_it() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(&db, dev_knobs(), xyz_source(format!("http://{addr}/xml"))).await;
        assert!(matches!(
            get_tile(&st, "s", 0, 0, 0, None).await,
            FetchOutcome::Unavailable
        ));
        assert!(st.cache.get(TileKey::new("s", 0, 0, 0)).unwrap().is_none());
    }

    #[tokio::test]
    async fn negative_caches_a_404() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(
            &db,
            dev_knobs(),
            xyz_source(format!("http://{addr}/missing")),
        )
        .await;
        assert!(matches!(
            get_tile(&st, "s", 0, 0, 0, None).await,
            FetchOutcome::Empty { status: 404 }
        ));
        let row = st.cache.get(TileKey::new("s", 0, 0, 0)).unwrap().unwrap();
        assert_eq!(row.status, 404);
        // A second request within the negative TTL serves from the negative cache.
        assert!(matches!(
            get_tile(&st, "s", 0, 0, 0, None).await,
            FetchOutcome::Empty { status: 404 }
        ));
    }

    #[tokio::test]
    async fn an_if_none_match_on_a_fresh_tile_returns_not_modified() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(
            &db,
            dev_knobs(),
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;
        let first = get_tile(&st, "s", 2, 1, 1, None).await;
        let etag = match first {
            FetchOutcome::Hit(r) => r.etag,
            _ => panic!("expected a hit"),
        };
        assert!(matches!(
            get_tile(&st, "s", 2, 1, 1, Some(etag)).await,
            FetchOutcome::NotModified { .. }
        ));
    }

    #[tokio::test]
    async fn serves_stale_when_the_upstream_is_offline() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        // fresh_secs 0 forces revalidation on every read, so the second read takes the offline path.
        let knobs = Knobs {
            fresh_secs: 0,
            ..dev_knobs()
        };
        let st = state_with(
            &db,
            knobs,
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;
        assert!(matches!(
            get_tile(&st, "s", 1, 0, 0, None).await,
            FetchOutcome::Hit(_)
        ));
        // Point the source at a dead port so the revalidation fetch fails (offline).
        st.sources.write().await.insert(
            "s".into(),
            xyz_source("http://127.0.0.1:1/img/{z}/{x}/{y}".into()),
        );
        match get_tile(&st, "s", 1, 0, 0, None).await {
            FetchOutcome::Hit(r) => {
                assert!(r.stale, "the offline read serves the stale cached tile")
            }
            _ => panic!("expected a stale hit"),
        }
    }

    #[tokio::test]
    async fn an_unknown_source_is_not_allowed() {
        let db = NamedTempFile::new().unwrap();
        let st = state_with(&db, dev_knobs(), xyz_source("http://x/{z}/{x}/{y}".into())).await;
        assert!(matches!(
            get_tile(&st, "nope", 0, 0, 0, None).await,
            FetchOutcome::NotAllowed
        ));
    }

    #[tokio::test]
    async fn a_timed_out_fetch_retries_once_at_the_escalated_timeout() {
        let hits = Arc::new(AtomicUsize::new(0));
        // Hit 1 sleeps 1s against the 100ms base timeout (a forced timeout); hit 2 answers instantly.
        let addr = spawn_counting_stub(hits.clone(), 1, std::time::Duration::from_secs(1)).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(
            &db,
            fast_timeout_knobs(),
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;
        assert!(
            matches!(
                get_tile(&st, "s", 1, 0, 0, None).await,
                FetchOutcome::Hit(_)
            ),
            "the single retry at the escalated timeout succeeds"
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "exactly one retry: two upstream hits"
        );
    }

    #[tokio::test]
    async fn a_timeout_is_never_negative_cached() {
        let hits = Arc::new(AtomicUsize::new(0));
        // Every hit sleeps 1s against the 100ms base, so both the initial fetch and its retry time out.
        let addr = spawn_counting_stub(hits, usize::MAX, std::time::Duration::from_secs(1)).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(
            &db,
            fast_timeout_knobs(),
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;
        assert!(matches!(
            get_tile(&st, "s", 1, 0, 0, None).await,
            FetchOutcome::Unavailable
        ));
        assert!(
            st.cache.get(TileKey::new("s", 1, 0, 0)).unwrap().is_none(),
            "a timeout leaves no cache row, unlike a 404"
        );
    }

    #[tokio::test]
    async fn repeated_timeouts_escalate_the_per_source_timeout() {
        let hits = Arc::new(AtomicUsize::new(0));
        // Hits 1 and 2 (the first request and its retry) sleep 1s; later hits answer instantly.
        let addr = spawn_counting_stub(hits, 2, std::time::Duration::from_secs(1)).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(
            &db,
            fast_timeout_knobs(),
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;
        // The first request times out twice, so the streak reaches 2 and the schedule reads base << 2.
        assert!(matches!(
            get_tile(&st, "s", 1, 0, 0, None).await,
            FetchOutcome::Unavailable
        ));
        assert_eq!(
            st.upstream_health.timeout_ms("s"),
            400,
            "two timeouts escalate the source to base << 2"
        );
        // The next request answers instantly and caches; the escalation stays sticky within the window.
        assert!(matches!(
            get_tile(&st, "s", 1, 0, 0, None).await,
            FetchOutcome::Hit(_)
        ));
        assert_eq!(
            st.upstream_health.timeout_ms("s"),
            400,
            "a success within the quiet window keeps the escalated timeout"
        );
    }

    #[tokio::test]
    async fn a_detached_fill_survives_caller_cancellation() {
        let hits = Arc::new(AtomicUsize::new(0));
        // Default base (20s), so no adaptive timing is in play. The stub sleeps 200ms then serves.
        let addr =
            spawn_counting_stub(hits, usize::MAX, std::time::Duration::from_millis(200)).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(
            &db,
            dev_knobs(),
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;
        // Cancel the caller at 50ms, before the 200ms upstream answers: the get_tile future is dropped.
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            get_tile(&st, "s", 3, 1, 2, None),
        )
        .await;
        // The detached fill completes the fetch and stores the tile, so the row appears shortly after.
        let mut appeared = false;
        for _ in 0..250 {
            if st.cache.get(TileKey::new("s", 3, 1, 2)).unwrap().is_some() {
                appeared = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            appeared,
            "the detached fill stored the tile despite the caller being cancelled"
        );
    }

    #[tokio::test]
    async fn a_slow_source_serves_stale_immediately() {
        let hits = Arc::new(AtomicUsize::new(0));
        // The revalidation stub sleeps 1s; fresh_secs 0 makes the primed tile immediately stale.
        let addr = spawn_counting_stub(hits, usize::MAX, std::time::Duration::from_secs(1)).await;
        let db = NamedTempFile::new().unwrap();
        let knobs = Knobs {
            fresh_secs: 0,
            ..dev_knobs()
        };
        let st = state_with(
            &db,
            knobs,
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;
        prime_stale_slow_tile(&st);
        // The stale hit returns immediately, well before the 1s revalidation would answer.
        let outcome = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            get_tile(&st, "s", 1, 0, 0, None),
        )
        .await;
        match outcome {
            Ok(FetchOutcome::Hit(r)) => {
                assert!(r.stale, "the slow source serves the stale tile immediately")
            }
            _ => panic!("expected a stale hit within 500ms"),
        }
    }

    #[tokio::test]
    async fn a_slow_source_answers_not_modified_for_a_matching_etag() {
        let hits = Arc::new(AtomicUsize::new(0));
        // The revalidation stub sleeps 1s; fresh_secs 0 makes the primed tile immediately stale.
        let addr = spawn_counting_stub(hits, usize::MAX, std::time::Duration::from_secs(1)).await;
        let db = NamedTempFile::new().unwrap();
        let knobs = Knobs {
            fresh_secs: 0,
            ..dev_knobs()
        };
        let st = state_with(
            &db,
            knobs,
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;
        prime_stale_slow_tile(&st);
        // A matching validator short-circuits to 304 immediately, well before the 1s revalidation.
        let outcome = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            get_tile(&st, "s", 1, 0, 0, Some("e".into())),
        )
        .await;
        match outcome {
            Ok(FetchOutcome::NotModified { etag }) => {
                assert_eq!(
                    etag, "e",
                    "the matching etag answers 304 with the stale etag"
                )
            }
            _ => panic!("expected a not-modified within 500ms"),
        }
    }

    #[tokio::test]
    async fn concurrent_stale_reads_on_a_slow_source_spawn_one_fill() {
        let hits = Arc::new(AtomicUsize::new(0));
        // Every hit sleeps 1s; fresh_secs 0 makes the primed tile immediately stale.
        let addr =
            spawn_counting_stub(hits.clone(), usize::MAX, std::time::Duration::from_secs(1)).await;
        let db = NamedTempFile::new().unwrap();
        let knobs = Knobs {
            fresh_secs: 0,
            ..dev_knobs()
        };
        let st = state_with(
            &db,
            knobs,
            xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}")),
        )
        .await;
        prime_stale_slow_tile(&st);
        // Both reads return the stale tile immediately; the spawn guard and the single-flight lock keep
        // the concurrent stale reads to a single in-flight upstream fetch.
        let a = get_tile(&st, "s", 1, 0, 0, None).await;
        let b = get_tile(&st, "s", 1, 0, 0, None).await;
        assert!(matches!(a, FetchOutcome::Hit(_)));
        assert!(matches!(b, FetchOutcome::Hit(_)));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "concurrent stale reads coalesce to one background fill"
        );
    }
}
