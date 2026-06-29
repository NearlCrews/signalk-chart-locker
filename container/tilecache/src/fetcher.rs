//! The read-through fetch path: serve a cached tile, revalidate a stale one when online, serve stale
//! when offline, fetch and store a miss, negative-cache a 404 or 204, and coalesce duplicate misses.
//! The egress is allowlist-keyed by source id, redirects are off (the client), and every upstream IP
//! is checked before connecting.

use crate::cache::CachedTile;
use crate::source::UpstreamTemplate;
use crate::state::{now_secs, AppState};
use crate::upstream::expand_upstream;
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;

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
    NotModified { etag: String },
    /// A negatively cached or upstream sparse-coverage response (status without a body).
    Empty { status: u16 },
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
    let mut h = Sha256::new();
    h.update(body);
    format!("\"{:x}\"", h.finalize())
}

/// Log a cache write that failed for a reason other than a graceful disk-full degrade, so a real DB
/// fault (locking, corruption) is visible in the container logs instead of silently dropped.
pub(crate) fn log_cache_err<T>(result: rusqlite::Result<T>) {
    if let Err(e) = result {
        eprintln!("tilecache: cache write failed: {e}");
    }
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

/// Fetch the upstream, returning (status, fetched) or an error on a transport failure (treated as
/// offline). SSRF is enforced by guarded_get (the literal-IP guard plus the client's guarded DNS
/// resolver), and the body is read under a streaming size cap, so a decompression or chunked bomb
/// cannot be read unbounded into memory.
pub(crate) async fn fetch_upstream(
    state: &AppState,
    url: &str,
    if_none_match: Option<&str>,
) -> Result<(u16, Fetched), ()> {
    let resp = state.guarded_get(url, if_none_match).await?;
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
    let body = state.read_capped(resp).await.ok_or(())?;
    Ok((status, Fetched { content_type, validator, body }))
}

/// Store a fetched 200 and return it, or negative-cache a 404 or 204. Rejects an oversize body or a
/// non-image content type (a WMS XML ServiceException returned with a 200) without storing.
fn store_200(state: &AppState, source_id: &str, z: u32, x: u32, y: u32, fetched: Fetched, if_none_match: Option<&str>) -> FetchOutcome {
    if fetched.body.len() > state.knobs.max_blob_bytes || !acceptable_content_type(&fetched.content_type) {
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
    log_cache_err(state.cache.put(source_id, z, x, y, &tile, false, now));
    // Soft reserve: the scroll cache uses the whole cap. evict_to(cap) drops only unpinned rows, so the
    // scroll cache fills the cap minus the bytes actually pinned by saved regions (the full cap when
    // nothing is pinned).
    log_cache_err(state.cache.evict_to(state.live_cap_bytes.load(Ordering::Relaxed)));
    if if_none_match == Some(etag.as_str()) {
        return FetchOutcome::NotModified { etag };
    }
    FetchOutcome::Hit(TileResponse { status: 200, content_type: fetched.content_type, etag, stale: false, body: fetched.body })
}

fn negative_cache(state: &AppState, source_id: &str, z: u32, x: u32, y: u32, status: u16) -> FetchOutcome {
    let now = now_secs();
    let tile = CachedTile {
        content_type: String::new(),
        strong_etag: String::new(),
        upstream_validator: None,
        status: status as i64,
        fetched_at: now,
        last_access: now,
        bytes: 0,
        blob: None,
    };
    log_cache_err(state.cache.put(source_id, z, x, y, &tile, false, now));
    FetchOutcome::Empty { status }
}

/// Serve a tile: cache-first, with revalidation, negative cache, serve-stale, and single-flight.
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

    // Cache-first.
    if let Ok(Some(tile)) = state.cache.get(source_id, z, x, y) {
        if tile.status != 200 {
            if now - tile.fetched_at < state.knobs.negative_ttl_secs {
                return FetchOutcome::Empty { status: tile.status as u16 };
            }
        } else if now - tile.fetched_at < state.knobs.fresh_secs {
            // Throttle the LRU write so a pan does not write to the microSD on every warm-tile read.
            if now - tile.last_access >= TOUCH_THROTTLE_SECS {
                log_cache_err(state.cache.touch(source_id, z, x, y, now));
            }
            if if_none_match.as_deref() == Some(&tile.strong_etag) {
                return FetchOutcome::NotModified { etag: tile.strong_etag };
            }
            return FetchOutcome::Hit(to_response(&tile, false));
        } else {
            // Stale: revalidate online, else serve stale within the max-stale bound.
            match fetch_upstream(state, &url, tile.upstream_validator.as_deref()).await {
                Ok((304, _)) => {
                    let mut refreshed = tile.clone();
                    refreshed.fetched_at = now;
                    refreshed.last_access = now;
                    log_cache_err(state.cache.put(source_id, z, x, y, &refreshed, false, now));
                    if if_none_match.as_deref() == Some(&tile.strong_etag) {
                        return FetchOutcome::NotModified { etag: tile.strong_etag };
                    }
                    return FetchOutcome::Hit(to_response(&tile, false));
                }
                Ok((200, fetched)) => {
                    return store_200(state, source_id, z, x, y, fetched, if_none_match.as_deref());
                }
                _ => {
                    if now - tile.fetched_at < state.knobs.max_stale_secs {
                        return FetchOutcome::Hit(to_response(&tile, true));
                    }
                }
            }
        }
    }

    // Miss (or expired negative or stale-too-old): single-flight the fetch.
    let key = format!("{source_id}/{z}/{x}/{y}");
    let lock = state.inflight_lock(&key).await;
    let _guard = lock.lock().await;
    // Re-check: another flight may have filled the cache while we waited.
    if let Ok(Some(tile)) = state.cache.get(source_id, z, x, y) {
        if tile.status == 200 && now_secs() - tile.fetched_at < state.knobs.fresh_secs {
            state.inflight_finish(&key, &lock).await;
            if if_none_match.as_deref() == Some(&tile.strong_etag) {
                return FetchOutcome::NotModified { etag: tile.strong_etag };
            }
            return FetchOutcome::Hit(to_response(&tile, false));
        }
    }
    let outcome = match fetch_upstream(state, &url, None).await {
        Ok((200, fetched)) => store_200(state, source_id, z, x, y, fetched, if_none_match.as_deref()),
        Ok((status @ (404 | 204), _)) => negative_cache(state, source_id, z, x, y, status),
        Ok(_) => FetchOutcome::Unavailable,
        Err(()) => {
            // Offline: serve any cached 200 within the max-stale bound.
            match state.cache.get(source_id, z, x, y) {
                Ok(Some(tile)) if tile.status == 200 && now_secs() - tile.fetched_at < state.knobs.max_stale_secs => {
                    FetchOutcome::Hit(to_response(&tile, true))
                }
                _ => FetchOutcome::Unavailable,
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

    async fn spawn_stub(hits: Arc<AtomicUsize>) -> SocketAddr {
        let h = hits.clone();
        let app = Router::new()
            .route(
                "/img/:z/:x/:y",
                get(move || {
                    let h = h.clone();
                    async move {
                        h.fetch_add(1, Ordering::SeqCst);
                        ([(header::CONTENT_TYPE, "image/png")], vec![1u8, 2, 3, 4])
                    }
                }),
            )
            .route("/xml", get(|| async { ([(header::CONTENT_TYPE, "text/xml")], "<ServiceException/>") }))
            .route("/missing", get(|| async { StatusCode::NOT_FOUND }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    fn xyz_source(url_template: String) -> ChartSource {
        ChartSource {
            id: "s".into(),
            title: "S".into(),
            upstream: UpstreamTemplate::Xyz { url_template },
            tile_size: 256,
            minzoom: 0,
            maxzoom: 18,
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
        Knobs { allow_private_egress: true, ..Default::default() }
    }

    #[tokio::test]
    async fn fetches_caches_and_coalesces_duplicate_misses() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits.clone()).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(&db, dev_knobs(), xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}"))).await;

        let (a, b) = tokio::join!(get_tile(&st, "s", 1, 0, 0, None), get_tile(&st, "s", 1, 0, 0, None));
        assert!(matches!(a, FetchOutcome::Hit(_)));
        assert!(matches!(b, FetchOutcome::Hit(_)));
        let c = get_tile(&st, "s", 1, 0, 0, None).await;
        assert!(matches!(c, FetchOutcome::Hit(_)));
        assert_eq!(hits.load(Ordering::SeqCst), 1, "single-flight and the cache mean one upstream fetch");
    }

    #[tokio::test]
    async fn rejects_a_non_image_200_and_does_not_store_it() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(&db, dev_knobs(), xyz_source(format!("http://{addr}/xml"))).await;
        assert!(matches!(get_tile(&st, "s", 0, 0, 0, None).await, FetchOutcome::Unavailable));
        assert!(st.cache.get("s", 0, 0, 0).unwrap().is_none());
    }

    #[tokio::test]
    async fn negative_caches_a_404() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(&db, dev_knobs(), xyz_source(format!("http://{addr}/missing"))).await;
        assert!(matches!(get_tile(&st, "s", 0, 0, 0, None).await, FetchOutcome::Empty { status: 404 }));
        let row = st.cache.get("s", 0, 0, 0).unwrap().unwrap();
        assert_eq!(row.status, 404);
        // A second request within the negative TTL serves from the negative cache.
        assert!(matches!(get_tile(&st, "s", 0, 0, 0, None).await, FetchOutcome::Empty { status: 404 }));
    }

    #[tokio::test]
    async fn an_if_none_match_on_a_fresh_tile_returns_not_modified() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let st = state_with(&db, dev_knobs(), xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}"))).await;
        let first = get_tile(&st, "s", 2, 1, 1, None).await;
        let etag = match first {
            FetchOutcome::Hit(r) => r.etag,
            _ => panic!("expected a hit"),
        };
        assert!(matches!(get_tile(&st, "s", 2, 1, 1, Some(etag)).await, FetchOutcome::NotModified { .. }));
    }

    #[tokio::test]
    async fn serves_stale_when_the_upstream_is_offline() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        // fresh_secs 0 forces revalidation on every read, so the second read takes the offline path.
        let knobs = Knobs { allow_private_egress: true, fresh_secs: 0, ..Default::default() };
        let st = state_with(&db, knobs, xyz_source(format!("http://{addr}/img/{{z}}/{{x}}/{{y}}"))).await;
        assert!(matches!(get_tile(&st, "s", 1, 0, 0, None).await, FetchOutcome::Hit(_)));
        // Point the source at a dead port so the revalidation fetch fails (offline).
        st.sources.write().await.insert("s".into(), xyz_source("http://127.0.0.1:1/img/{z}/{x}/{y}".into()));
        match get_tile(&st, "s", 1, 0, 0, None).await {
            FetchOutcome::Hit(r) => assert!(r.stale, "the offline read serves the stale cached tile"),
            _ => panic!("expected a stale hit"),
        }
    }

    #[tokio::test]
    async fn an_unknown_source_is_not_allowed() {
        let db = NamedTempFile::new().unwrap();
        let st = state_with(&db, dev_knobs(), xyz_source("http://x/{z}/{x}/{y}".into())).await;
        assert!(matches!(get_tile(&st, "nope", 0, 0, 0, None).await, FetchOutcome::NotAllowed));
    }
}
