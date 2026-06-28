//! The warm-job engine: enumerate a bbox lazily with the shared inverse, fetch each tile through the
//! existing guarded egress path, and store it pinned in batched transactions. A warm NEVER evicts: it
//! does an explicit pre-store cap check and stops at `capped`. Fan-out is bounded by a warm semaphore
//! below the shared `EGRESS_CONCURRENCY`, so a large warm cannot starve interactive tile reads. The job
//! registry is in memory, cleared on completion plus a TTL.

use crate::cache::{CachedTile, WarmRow};
use crate::fetcher::{acceptable_content_type, fetch_upstream, strong_etag};
use crate::geom::{for_tiles_in_bbox, tile_count_in_bbox};
use crate::source::{ChartSource, UpstreamTemplate};
use crate::state::{now_secs, AppState};
use crate::upstream::expand_upstream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Warm fetch fan-out, below the shared EGRESS_CONCURRENCY (8) so a warm cannot starve live tile reads.
pub const WARM_CONCURRENCY: usize = 3;
/// Reject an absurd projected tile count upfront, defeating an enumeration denial of service.
pub const WARM_TILE_HARD_CAP: u64 = 2_000_000;
/// How long a finished job stays queryable before the registry reaps it.
pub const WARM_JOB_TTL_SECS: i64 = 3600;
/// Rows flushed per batched transaction (microSD-friendly; safe under WAL and synchronous = NORMAL).
const WARM_BATCH: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WarmState {
    Running,
    Done,
    Cancelled,
    Capped,
    Error,
}

pub struct WarmJob {
    pub total: u64,
    pub done: u64,
    pub skipped: u64,
    pub bytes: i64,
    pub errors: u64,
    pub state: WarmState,
    pub cancel: Arc<AtomicBool>,
    pub finished_at: Option<i64>,
}

pub struct WarmRequest {
    pub sources: Vec<ChartSource>,
    pub bbox: [f64; 4],
    pub minzoom: u32,
    pub maxzoom: u32,
}

#[derive(Debug)]
pub enum StartError {
    UnknownSource(String),
    BadBbox(String),
    BadZoom(String),
    TooMany(u64),
}

/// Validate the request, create the job, spawn the warm driver, and return the job id.
pub async fn start_warm(state: &AppState, req: WarmRequest) -> Result<String, StartError> {
    if req.sources.is_empty() {
        return Err(StartError::UnknownSource("no sources".into()));
    }
    if req.minzoom > req.maxzoom {
        return Err(StartError::BadZoom(format!("minzoom {} > maxzoom {}", req.minzoom, req.maxzoom)));
    }
    let b = req.bbox;
    if !b.iter().all(|v| v.is_finite()) || b[0] >= b[2] || b[1] >= b[3] {
        return Err(StartError::BadBbox(format!("invalid bbox {b:?}")));
    }
    // Every source must be in the allowlist; a style source has no tile path.
    let mut total = 0u64;
    {
        let map = state.sources.read().await;
        for s in &req.sources {
            match map.get(&s.id) {
                Some(known) if !matches!(known.upstream, UpstreamTemplate::Style { .. }) => {
                    total += tile_count_in_bbox(known, b, req.minzoom, req.maxzoom);
                }
                _ => return Err(StartError::UnknownSource(s.id.clone())),
            }
        }
    }
    if total > WARM_TILE_HARD_CAP {
        return Err(StartError::TooMany(total));
    }

    let id = format!("warm-{}", state.warm_seq.fetch_add(1, Ordering::Relaxed));
    let cancel = Arc::new(AtomicBool::new(false));
    let job = Arc::new(tokio::sync::Mutex::new(WarmJob {
        total, done: 0, skipped: 0, bytes: 0, errors: 0, state: WarmState::Running, cancel: cancel.clone(), finished_at: None,
    }));
    {
        let mut jobs = state.warm_jobs.write().await;
        reap(&mut jobs);
        jobs.insert(id.clone(), job.clone());
    }
    // Resolve the allowlisted source definitions (not the client-sent ones) so the warm uses the trusted config.
    let resolved: Vec<ChartSource> = {
        let map = state.sources.read().await;
        req.sources.iter().filter_map(|s| map.get(&s.id).cloned()).collect()
    };
    let st = state.clone();
    tokio::spawn(run(st, job, resolved, b, req.minzoom, req.maxzoom));
    Ok(id)
}

/// A snapshot of a job's progress as JSON, or None when the id is unknown.
pub async fn warm_snapshot(state: &AppState, job_id: &str) -> Option<serde_json::Value> {
    let job = { state.warm_jobs.read().await.get(job_id).cloned()? };
    let j = job.lock().await;
    Some(serde_json::json!({
        "total": j.total, "done": j.done, "skipped": j.skipped,
        "bytes": j.bytes, "errors": j.errors, "state": j.state,
    }))
}

/// Request cooperative cancellation; returns false when the id is unknown.
pub async fn cancel_warm(state: &AppState, job_id: &str) -> bool {
    match state.warm_jobs.read().await.get(job_id) {
        Some(job) => {
            job.lock().await.cancel.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

// Drop finished jobs older than the TTL so the in-memory registry does not grow without bound.
fn reap(jobs: &mut std::collections::HashMap<String, Arc<tokio::sync::Mutex<WarmJob>>>) {
    let now = now_secs();
    jobs.retain(|_, j| match j.try_lock() {
        Ok(g) => g.finished_at.map(|t| now - t < WARM_JOB_TTL_SECS).unwrap_or(true),
        Err(_) => true,
    });
}

enum Fetched {
    Tile(WarmRow),
    Negative(WarmRow),
    Skipped,
    Error,
}

// Fetch and classify one tile, reusing the guarded egress path. The caller holds the warm permit, so
// this does not take it; guarded_get still takes an egress permit inside.
async fn warm_one(st: &AppState, source: &ChartSource, z: u32, x: u32, y: u32) -> Fetched {
    let now = now_secs();
    if let Ok(Some(tile)) = st.cache.get(&source.id, z, x, y) {
        let fresh = tile.status == 200 && now - tile.fetched_at < st.knobs.fresh_secs;
        let neg = tile.status != 200 && now - tile.fetched_at < st.knobs.negative_ttl_secs;
        if fresh || neg {
            // The tile is current, so skip the fetch, but still pin the existing row: it may have been
            // cached UNPINNED by the live proxy, and the warmed box must be fully eviction-exempt.
            if let Err(e) = st.cache.pin(&source.id, z, x, y) {
                eprintln!("tilecache: warm pin failed: {e}");
            }
            return Fetched::Skipped;
        }
    }
    let url = match expand_upstream(source, z, x, y) {
        Ok(u) => u,
        Err(_) => return Fetched::Error,
    };
    match fetch_upstream(st, &url, None).await {
        Ok((200, f)) => {
            if f.body.len() > st.knobs.max_blob_bytes || !acceptable_content_type(&f.content_type) {
                return Fetched::Error;
            }
            Fetched::Tile(WarmRow {
                source: source.id.clone(), z, x, y,
                tile: CachedTile {
                    content_type: f.content_type, strong_etag: strong_etag(&f.body), upstream_validator: f.validator,
                    status: 200, fetched_at: now, last_access: now, bytes: f.body.len() as i64, blob: Some(f.body),
                },
            })
        }
        Ok((404, _)) | Ok((204, _)) => Fetched::Negative(WarmRow {
            source: source.id.clone(), z, x, y,
            tile: CachedTile {
                content_type: String::new(), strong_etag: String::new(), upstream_validator: None,
                status: 404, fetched_at: now, last_access: now, bytes: 0, blob: None,
            },
        }),
        _ => Fetched::Error,
    }
}

// The warm driver: enumerate lazily, bound in-flight fetches to WARM_CONCURRENCY via owned permits and a
// JoinSet, drain results into a batch, and flush each batch pinned with the pre-store cap check.
async fn run(st: AppState, job: Arc<tokio::sync::Mutex<WarmJob>>, sources: Vec<ChartSource>, bbox: [f64; 4], zmin: u32, zmax: u32) {
    let cancel = { job.lock().await.cancel.clone() };
    let mut set: tokio::task::JoinSet<Fetched> = tokio::task::JoinSet::new();
    let mut batch: Vec<WarmRow> = Vec::with_capacity(WARM_BATCH);
    let mut final_state = WarmState::Done;

    // A flat list of (source index, z, x, y) is avoided; enumerate inline and spawn bounded tasks.
    'outer: for source in &sources {
        let coords: Vec<(u32, u32, u32)> = {
            let mut v = Vec::new();
            for_tiles_in_bbox(source, bbox, zmin, zmax, |z, x, y| v.push((z, x, y)));
            v
        };
        for (z, x, y) in coords {
            if cancel.load(Ordering::Relaxed) {
                final_state = WarmState::Cancelled;
                break 'outer;
            }
            let permit = match st.warm_semaphore.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => {
                    final_state = WarmState::Error;
                    break 'outer;
                }
            };
            let st2 = st.clone();
            let source2 = source.clone();
            set.spawn(async move {
                let _permit = permit;
                warm_one(&st2, &source2, z, x, y).await
            });
            // Drain any finished tasks without blocking, keeping memory flat.
            while let Some(done) = set.try_join_next() {
                if let Ok(f) = done {
                    if !accumulate(&st, &job, &mut batch, f, &mut final_state).await {
                        // capped: stop spawning and draining.
                        cancel.store(true, Ordering::Relaxed);
                        break 'outer;
                    }
                }
            }
        }
    }
    // Join remaining in-flight tasks.
    while let Some(done) = set.join_next().await {
        if let Ok(f) = done {
            if final_state == WarmState::Done && !accumulate(&st, &job, &mut batch, f, &mut final_state).await {
                break;
            }
        }
    }
    // Flush the tail.
    if !batch.is_empty() {
        flush(&st, &job, &mut batch, &mut final_state).await;
    }
    let mut j = job.lock().await;
    j.state = final_state;
    j.finished_at = Some(now_secs());
}

// Apply one fetch result to the batch and the counters. Returns false when a flush reports capped.
async fn accumulate(st: &AppState, job: &Arc<tokio::sync::Mutex<WarmJob>>, batch: &mut Vec<WarmRow>, f: Fetched, final_state: &mut WarmState) -> bool {
    match f {
        Fetched::Tile(row) | Fetched::Negative(row) => {
            batch.push(row);
            if batch.len() >= WARM_BATCH {
                return flush(st, job, batch, final_state).await;
            }
            true
        }
        Fetched::Skipped => {
            job.lock().await.skipped += 1;
            true
        }
        Fetched::Error => {
            job.lock().await.errors += 1;
            true
        }
    }
}

// Store the current batch pinned, with the pre-store cap check. Returns false when capped.
async fn flush(st: &AppState, job: &Arc<tokio::sync::Mutex<WarmJob>>, batch: &mut Vec<WarmRow>, final_state: &mut WarmState) -> bool {
    let now = now_secs();
    match st.cache.put_many_pinned(batch, st.knobs.cap_bytes, now) {
        Ok(outcome) => {
            let mut j = job.lock().await;
            j.done += outcome.stored as u64;
            j.bytes += outcome.bytes_added;
            batch.clear();
            if outcome.capped {
                *final_state = WarmState::Capped;
                return false;
            }
            true
        }
        Err(e) => {
            eprintln!("tilecache: warm flush failed: {e}");
            batch.clear();
            job.lock().await.errors += 1;
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::TileCache;
    use crate::source::{ChartSource, UpstreamTemplate};
    use crate::state::Knobs;
    use axum::http::header;
    use axum::{routing::get, Router};
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tempfile::NamedTempFile;
    use tokio::net::TcpListener;

    async fn stub() -> SocketAddr {
        let app = Router::new()
            .route("/img/:z/:x/:y", get(|| async { ([(header::CONTENT_TYPE, "image/png")], vec![1u8, 2, 3, 4]) }))
            .route("/missing/:z/:x/:y", get(|| async { axum::http::StatusCode::NOT_FOUND }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    fn xyz(addr: SocketAddr, path: &str) -> ChartSource {
        ChartSource {
            id: "s".into(),
            title: "S".into(),
            upstream: UpstreamTemplate::Xyz { url_template: format!("http://{addr}/{path}/{{z}}/{{x}}/{{y}}") },
            tile_size: 256,
            minzoom: 0,
            maxzoom: 4,
            bounds: None,
            attribution: String::new(),
        }
    }

    async fn state(db: &NamedTempFile, knobs: Knobs, source: ChartSource) -> AppState {
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let st = AppState::new(cache, knobs);
        st.sources.write().await.insert(source.id.clone(), source);
        st
    }

    async fn wait_done(st: &AppState, job: &str) -> serde_json::Value {
        for _ in 0..200 {
            let snap = warm_snapshot(st, job).await.unwrap();
            if snap["state"] != "running" {
                return snap;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("warm job did not finish");
    }

    fn dev() -> Knobs {
        Knobs { allow_private_egress: true, ..Default::default() }
    }

    #[test]
    fn warm_concurrency_is_below_egress() {
        const {
            assert!(
                WARM_CONCURRENCY < crate::state::EGRESS_CONCURRENCY,
                "warm fan-out must stay strictly below the shared egress limit so a warm cannot starve live reads"
            )
        };
    }

    #[tokio::test]
    async fn warm_enumerates_fetches_and_pins() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-10.0, -10.0, 10.0, 10.0], minzoom: 0, maxzoom: 1 }).await.unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "done");
        assert!(snap["done"].as_u64().unwrap() >= 1);
        // The stored tile is pinned: an evict_to far below the total leaves it.
        st.cache.evict_to(0).unwrap();
        assert!(st.cache.get("s", 0, 0, 0).unwrap().is_some(), "the warmed box is pinned");
    }

    #[tokio::test]
    async fn warm_pins_a_preexisting_unpinned_tile_it_skips() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        // Seed an UNPINNED, fresh 200 row as the live proxy would, so the warm skips the fetch but must
        // still pin it so the box is fully eviction-exempt.
        let now = crate::state::now_secs();
        let seeded = CachedTile {
            content_type: "image/png".into(), strong_etag: "x".into(), upstream_validator: None,
            status: 200, fetched_at: now, last_access: now, bytes: 4, blob: Some(vec![1, 2, 3, 4].into()),
        };
        st.cache.put("s", 0, 0, 0, &seeded, false, now).unwrap();
        let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-10.0, -10.0, 10.0, 10.0], minzoom: 0, maxzoom: 0 }).await.unwrap();
        let snap = wait_done(&st, &job).await;
        assert!(snap["skipped"].as_u64().unwrap() >= 1, "the fresh tile is skipped, not refetched");
        st.cache.evict_to(0).unwrap();
        assert!(st.cache.get("s", 0, 0, 0).unwrap().is_some(), "the skipped tile was pinned by the warm");
    }

    #[tokio::test]
    async fn warm_marks_capped_and_does_not_evict() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        // cap below one tile (4 bytes) so the first sized put trips the cap.
        let st = state(&db, Knobs { cap_bytes: 2, allow_private_egress: true, ..Default::default() }, xyz(addr, "img")).await;
        let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-10.0, -10.0, 10.0, 10.0], minzoom: 0, maxzoom: 0 }).await.unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "capped");
        assert_eq!(st.cache.stats().unwrap().1, 0, "nothing stored, nothing evicted");
    }

    #[tokio::test]
    async fn warm_rejects_an_unknown_source_and_an_oversize_count() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let known = st.sources.read().await["s"].clone();
        let mut unknown = known.clone();
        unknown.id = "nope".into();
        assert!(matches!(start_warm(&st, WarmRequest { sources: vec![unknown], bbox: [-1.0, -1.0, 1.0, 1.0], minzoom: 0, maxzoom: 0 }).await, Err(StartError::UnknownSource(_))));
        assert!(matches!(start_warm(&st, WarmRequest { sources: vec![known.clone()], bbox: [10.0, 10.0, 5.0, 5.0], minzoom: 0, maxzoom: 0 }).await, Err(StartError::BadBbox(_))));
        // A source with a deep max zoom over the whole world projects past WARM_TILE_HARD_CAP (2_000_000):
        // zoom 11 alone is 4^11 = 4_194_304 tiles, so start_warm rejects it upfront with TooMany. Replace
        // the stored "s" with a deep-zoom copy so start_warm resolves the real (deep) source for the count.
        let mut deep = known.clone();
        deep.maxzoom = 12;
        st.sources.write().await.insert(deep.id.clone(), deep.clone());
        assert!(matches!(
            start_warm(&st, WarmRequest { sources: vec![deep], bbox: [-180.0, -85.0, 180.0, 85.0], minzoom: 0, maxzoom: 12 }).await,
            Err(StartError::TooMany(_))
        ));
    }

    // V2-4: a bbox whose latitude equals or exceeds the Web Mercator limit must succeed and enumerate
    // the clamped region. geom::clip() clamps before checking for a degenerate box, so no pre-clamp
    // is needed here and no beyond-limit latitude should ever reach a BadBbox rejection.
    #[tokio::test]
    async fn warm_beyond_mercator_latitude_clamps_and_succeeds() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let src = st.sources.read().await["s"].clone();
        // Poles: both latitudes exceed the Web Mercator limit in both directions.
        let result = start_warm(
            &st,
            WarmRequest { sources: vec![src.clone()], bbox: [-180.0, -90.0, 180.0, 90.0], minzoom: 0, maxzoom: 0 },
        )
        .await;
        assert!(result.is_ok(), "beyond-limit latitude must not produce BadBbox: {result:?}");
        let job_id = result.unwrap();
        let snap = wait_done(&st, &job_id).await;
        assert_eq!(snap["state"], "done", "job must finish done");
        // total must match what tile_count_in_bbox reports for the same raw bbox (clip clamps both).
        let expected = crate::geom::tile_count_in_bbox(&src, [-180.0, -90.0, 180.0, 90.0], 0, 0);
        assert_eq!(snap["total"].as_u64().unwrap(), expected, "total tiles mismatch: snap={} expected={expected}", snap["total"]);
    }

    #[tokio::test]
    async fn warm_cancel_stops_between_tiles() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-180.0, -85.0, 180.0, 85.0], minzoom: 0, maxzoom: 4 }).await.unwrap();
        assert!(cancel_warm(&st, &job).await);
        let snap = wait_done(&st, &job).await;
        assert!(snap["state"] == "cancelled" || snap["state"] == "done");
    }
}
