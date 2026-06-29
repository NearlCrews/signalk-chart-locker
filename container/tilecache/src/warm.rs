//! The warm-job engine: enumerate a bbox lazily with the shared inverse, fetch each tile through the
//! existing guarded egress path, and store it pinned in batched transactions. A warm never evicts a
//! pinned tile: it evicts unpinned scroll tiles to fit within the cap, with an explicit pre-store
//! budget check that stops at `capped` when the pinned set would exceed the regions budget. Fan-out is
//! bounded by a warm semaphore
//! below the shared `EGRESS_CONCURRENCY`, so a large warm cannot starve interactive tile reads. The job
//! registry is in memory, cleared on completion plus a TTL.

use crate::cache::{CachedTile, WarmRow};
use crate::fetcher::{acceptable_content_type, fetch_upstream, strong_etag};
use crate::geom::{tile_count_in_bbox, tiles_iter};
use crate::source::{ChartSource, UpstreamTemplate};
use crate::state::{now_secs, AppState};
use crate::upstream::expand_upstream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Warm fetch fan-out, below the shared EGRESS_CONCURRENCY (8) so a warm cannot starve live tile reads.
pub const WARM_CONCURRENCY: usize = 3;
/// Reject an absurd projected tile count upfront, defeating an enumeration denial of service.
pub const WARM_TILE_HARD_CAP: u64 = 2_000_000;
/// Maximum concurrently RUNNING warm jobs. The admin prewarm route and the position-warm loop can
/// both drive /warm, so the cap prevents runaway goroutine pressure even with both active.
pub const MAX_ACTIVE_WARM_JOBS: usize = 4;
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
    /// The region this warm pins under, or None for an unpinned-budget warm. Kept for snapshots.
    pub region_id: Option<String>,
}

pub struct WarmRequest {
    pub sources: Vec<ChartSource>,
    pub bbox: [f64; 4],
    pub minzoom: u32,
    pub maxzoom: u32,
    /// The region to pin under (real region, or the position-warm pseudo-region), or None.
    pub region_id: Option<String>,
}

#[derive(Debug)]
pub enum StartError {
    UnknownSource(String),
    BadBbox(String),
    BadZoom(String),
    TooMany(u64),
    TooManyJobs,
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
        region_id: req.region_id.clone(),
    }));
    {
        let mut jobs = state.warm_jobs.write().await;
        reap(&mut jobs);
        // Count and insert under the write lock so the cap check and the insert are atomic with
        // respect to other concurrent start_warm calls.
        let active = jobs.values().filter(|j| {
            match j.try_lock() {
                Ok(g) => g.state == WarmState::Running,
                Err(_) => true, // locked by the driver mid-run: treat as running
            }
        }).count();
        if active >= MAX_ACTIVE_WARM_JOBS {
            return Err(StartError::TooManyJobs);
        }
        jobs.insert(id.clone(), job.clone());
    }
    // Resolve the allowlisted source definitions (not the client-sent ones) so the warm uses the trusted config.
    let resolved: Vec<ChartSource> = {
        let map = state.sources.read().await;
        req.sources.iter().filter_map(|s| map.get(&s.id).cloned()).collect()
    };
    let st = state.clone();
    tokio::spawn(run(st, job, resolved, b, req.minzoom, req.maxzoom, req.region_id));
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

// The effective pinned budget for a warm: R for the position-warm pseudo-region, R - P for a real
// region (and for a region-less warm). Clamped to the live cap so R <= cap holds inside the container
// regardless of what POST /config delivered, and floored at 0. Read live so a POST /config retune
// takes effect mid-run.
fn effective_budget(st: &AppState, region_id: Option<&str>) -> i64 {
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    let r = st.live_regions_budget.load(Ordering::Relaxed);
    let p = st.live_position_warm_budget.load(Ordering::Relaxed);
    let raw = if region_id == Some(crate::state::POSITION_WARM_REGION_ID) { r } else { r - p };
    raw.min(cap).max(0)
}

// Fetch and classify one tile, reusing the guarded egress path. The caller holds the warm permit, so
// this does not take it; guarded_get still takes an egress permit inside.
async fn warm_one(st: &AppState, source: &ChartSource, z: u32, x: u32, y: u32, region_id: Option<&str>) -> Fetched {
    let now = now_secs();
    // pin_if_fresh does the freshness check, the budget gate, and the pin under one lock, closing the
    // race where a concurrent evict_to could delete the row between a separate get() and pin() call.
    match st.cache.pin_if_fresh(&source.id, z, x, y, now, st.knobs.fresh_secs, st.knobs.negative_ttl_secs, effective_budget(st, region_id), region_id) {
        Ok(true) => return Fetched::Skipped,
        Ok(false) => {} // absent, stale, or over budget: fall through to fetch (the flush gate decides)
        Err(e) => eprintln!("tilecache: warm pin_if_fresh failed: {e}"),
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
// JoinSet, drain results into a batch, and flush each batch pinned with the pre-store budget check.
async fn run(st: AppState, job: Arc<tokio::sync::Mutex<WarmJob>>, sources: Vec<ChartSource>, bbox: [f64; 4], zmin: u32, zmax: u32, region_id: Option<String>) {
    // Clear this region's prior pins so a re-download or a position-warm re-pin replaces the prior tile
    // set with no orphan join rows (a narrower box leaves nothing pinned outside the new set).
    if let Some(rid) = region_id.as_deref() {
        crate::fetcher::log_cache_err(st.cache.delete_region(rid));
    }
    let cancel = { job.lock().await.cancel.clone() };
    let mut set: tokio::task::JoinSet<Fetched> = tokio::task::JoinSet::new();
    let mut batch: Vec<WarmRow> = Vec::with_capacity(WARM_BATCH);
    let mut final_state = WarmState::Done;

    // Enumerate tiles lazily via tiles_iter (zero extra allocation beyond the iterator struct) and
    // spawn bounded tasks. The cancel check between tiles keeps the cooperative cancel responsive.
    'outer: for source in &sources {
        for (z, x, y) in tiles_iter(source, bbox, zmin, zmax) {
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
            let rid = region_id.clone();
            set.spawn(async move {
                let _permit = permit;
                warm_one(&st2, &source2, z, x, y, rid.as_deref()).await
            });
            // Drain any finished tasks without blocking, keeping memory flat.
            while let Some(done) = set.try_join_next() {
                if let Ok(f) = done {
                    if !accumulate(&st, &job, &mut batch, f, region_id.as_deref(), &mut final_state).await {
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
            if final_state == WarmState::Done && !accumulate(&st, &job, &mut batch, f, region_id.as_deref(), &mut final_state).await {
                break;
            }
        }
    }
    // Flush the tail.
    if !batch.is_empty() {
        flush(&st, &job, &mut batch, region_id.as_deref(), &mut final_state).await;
    }
    let mut j = job.lock().await;
    j.state = final_state;
    j.finished_at = Some(now_secs());
}

// Apply one fetch result to the batch and the counters. Returns false when a flush reports capped.
async fn accumulate(st: &AppState, job: &Arc<tokio::sync::Mutex<WarmJob>>, batch: &mut Vec<WarmRow>, f: Fetched, region_id: Option<&str>, final_state: &mut WarmState) -> bool {
    match f {
        Fetched::Tile(row) | Fetched::Negative(row) => {
            batch.push(row);
            if batch.len() >= WARM_BATCH {
                return flush(st, job, batch, region_id, final_state).await;
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

// Store the current batch pinned, with the pre-store budget check. Returns false when capped.
async fn flush(st: &AppState, job: &Arc<tokio::sync::Mutex<WarmJob>>, batch: &mut Vec<WarmRow>, region_id: Option<&str>, final_state: &mut WarmState) -> bool {
    let now = now_secs();
    match st.cache.put_many_pinned(batch, effective_budget(st, region_id), st.live_cap_bytes.load(Ordering::Relaxed), region_id, now) {
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
        let cap = knobs.cap_bytes;
        let st = AppState::new(cache, knobs);
        // A warm now gates on the regions budget R (POST /config sets it in production). Mirror the old
        // cap-based gating in tests by reserving the whole cap as R, so the budget equals what these
        // tests expect (P = 0, so a region-less warm gates against R = cap).
        st.live_regions_budget.store(cap, Ordering::Relaxed);
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
    fn effective_budget_clamps_a_configured_r_above_the_cap() {
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let st = AppState::new(cache, dev());
        // A POST /config delivered R = 5000 with a 1000-byte cap and P = 0: R exceeds the cap.
        st.live_cap_bytes.store(1000, Ordering::Relaxed);
        st.live_regions_budget.store(5000, Ordering::Relaxed);
        st.live_position_warm_budget.store(0, Ordering::Relaxed);
        // A real region's effective budget clamps to the cap, not to R - P.
        assert_eq!(effective_budget(&st, Some("r1")), 1000, "R - P clamps to the cap");
        // The position-warm pseudo-region clamps to the cap too.
        assert_eq!(
            effective_budget(&st, Some(crate::state::POSITION_WARM_REGION_ID)),
            1000,
            "R clamps to the cap",
        );
        // A negative R - P floors at 0.
        st.live_regions_budget.store(100, Ordering::Relaxed);
        st.live_position_warm_budget.store(500, Ordering::Relaxed);
        assert_eq!(effective_budget(&st, Some("r1")), 0, "R - P floors at 0");
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
        let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-10.0, -10.0, 10.0, 10.0], minzoom: 0, maxzoom: 1, region_id: None }).await.unwrap();
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
        let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-10.0, -10.0, 10.0, 10.0], minzoom: 0, maxzoom: 0, region_id: None }).await.unwrap();
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
        let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-10.0, -10.0, 10.0, 10.0], minzoom: 0, maxzoom: 0, region_id: None }).await.unwrap();
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
        assert!(matches!(start_warm(&st, WarmRequest { sources: vec![unknown], bbox: [-1.0, -1.0, 1.0, 1.0], minzoom: 0, maxzoom: 0, region_id: None }).await, Err(StartError::UnknownSource(_))));
        assert!(matches!(start_warm(&st, WarmRequest { sources: vec![known.clone()], bbox: [10.0, 10.0, 5.0, 5.0], minzoom: 0, maxzoom: 0, region_id: None }).await, Err(StartError::BadBbox(_))));
        // A source with a deep max zoom over the whole world projects past WARM_TILE_HARD_CAP (2_000_000):
        // zoom 11 alone is 4^11 = 4_194_304 tiles, so start_warm rejects it upfront with TooMany. Replace
        // the stored "s" with a deep-zoom copy so start_warm resolves the real (deep) source for the count.
        let mut deep = known.clone();
        deep.maxzoom = 12;
        st.sources.write().await.insert(deep.id.clone(), deep.clone());
        assert!(matches!(
            start_warm(&st, WarmRequest { sources: vec![deep], bbox: [-180.0, -85.0, 180.0, 85.0], minzoom: 0, maxzoom: 12, region_id: None }).await,
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
            WarmRequest { sources: vec![src.clone()], bbox: [-180.0, -90.0, 180.0, 90.0], minzoom: 0, maxzoom: 0, region_id: None },
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
    async fn concurrent_job_cap_rejects_excess_starts() {
        // Use a slow stub so all MAX_ACTIVE_WARM_JOBS jobs stay Running while we attempt the extra one.
        let app = axum::Router::new().route(
            "/slow/:z/:x/:y",
            get(|| async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                ([(header::CONTENT_TYPE, "image/png")], vec![1u8, 2, 3, 4])
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let db = NamedTempFile::new().unwrap();
        // Source maxzoom = 4 so each job has enough tiles to not finish immediately.
        let st = state(&db, dev(), xyz(addr, "slow")).await;
        // Swap the source for a version pointing at /slow so warm_one stalls.
        {
            let mut map = st.sources.write().await;
            let mut s = map["s"].clone();
            s.upstream = crate::source::UpstreamTemplate::Xyz {
                url_template: format!("http://{addr}/slow/{{z}}/{{x}}/{{y}}"),
            };
            map.insert(s.id.clone(), s);
        }

        let mut ids = Vec::new();
        for _ in 0..MAX_ACTIVE_WARM_JOBS {
            let job = start_warm(&st, WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-180.0, -85.0, 180.0, 85.0],
                minzoom: 0,
                maxzoom: 4,
                region_id: None,
            }).await.unwrap();
            ids.push(job);
        }

        // The (MAX_ACTIVE_WARM_JOBS + 1)th start must be rejected.
        let result = start_warm(&st, WarmRequest {
            sources: vec![st.sources.read().await["s"].clone()],
            bbox: [-1.0, -1.0, 1.0, 1.0],
            minzoom: 0,
            maxzoom: 0,
            region_id: None,
        }).await;
        assert!(
            matches!(result, Err(StartError::TooManyJobs)),
            "expected TooManyJobs, got {result:?}"
        );

        // Clean up: cancel all stalled jobs.
        for id in &ids {
            cancel_warm(&st, id).await;
        }
    }

    #[tokio::test]
    async fn warm_cancel_stops_between_tiles() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-180.0, -85.0, 180.0, 85.0], minzoom: 0, maxzoom: 4, region_id: None }).await.unwrap();
        assert!(cancel_warm(&st, &job).await);
        let snap = wait_done(&st, &job).await;
        assert!(snap["state"] == "cancelled" || snap["state"] == "done");
    }
}
