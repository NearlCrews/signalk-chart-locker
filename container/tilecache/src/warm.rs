//! The warm-job engine: enumerate a bbox lazily with the shared inverse, fetch each tile through the
//! existing guarded egress path, and store it pinned in batched transactions. A warm never evicts a
//! pinned tile: it evicts unpinned scroll tiles to fit within the cap, with an explicit pre-store
//! budget check that stops at `capped` when the pinned set would exceed the regions budget. Fan-out is
//! bounded by a warm semaphore
//! below the shared `EGRESS_CONCURRENCY`, so a large warm cannot starve interactive tile reads. The job
//! registry is in memory, cleared on completion plus a TTL.

use crate::cache::{CachedTile, FreshPinOutcome, PinBudgets, TileKey, WarmRow};
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
/// Maximum concurrently RUNNING warm jobs. The admin regions route and the position-warm loop can
/// both drive /warm, so the cap prevents runaway task and retained-batch pressure.
pub const MAX_ACTIVE_WARM_JOBS: usize = 2;
pub const MAX_WARM_SOURCES: usize = 64;
/// How long a finished job stays queryable before the registry reaps it.
pub const WARM_JOB_TTL_SECS: i64 = 3600;
pub const MAX_RETAINED_WARM_JOBS: usize = 128;
/// Rows flushed per batched transaction (microSD-friendly; safe under WAL and synchronous = NORMAL).
const WARM_BATCH: usize = 64;
/// Bound buffered response bodies independently of row count for memory-constrained hosts. A batch
/// can exceed this threshold by at most one maximum-size body before it is flushed.
pub(crate) const WARM_BATCH_BYTES: i64 = 4 * 1024 * 1024;
pub(crate) const MAX_RETAINED_WARM_BATCH_BYTES: usize =
    WARM_BATCH_BYTES as usize + crate::state::DEFAULT_MAX_BLOB_BYTES;
/// Completed fetch results release their warm permit before the driver removes them from its JoinSet,
/// so account for one maximum-size body per global warm permit in addition to buffered batches.
pub(crate) const MAX_RETAINED_COMPLETED_WARM_RESULTS_BYTES: usize =
    WARM_CONCURRENCY * crate::state::DEFAULT_MAX_BLOB_BYTES;

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
    pub region_id: Option<String>,
    pub created_at: i64,
    pub order: u64,
}

pub struct WarmRequest {
    pub sources: Vec<ChartSource>,
    pub bbox: [f64; 4],
    /// A second box used only when a position-radius crosses the antimeridian.
    pub additional_bbox: Option<[f64; 4]>,
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
    MultipleStyleSources,
    RegionBusy,
    BadRegion(String),
    ShuttingDown,
}

pub fn valid_region_id(region_id: &str) -> bool {
    if region_id == crate::state::POSITION_WARM_REGION_ID {
        return true;
    }
    let bytes = region_id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && region_id != crate::state::BASEMAP_ASSETS_REGION_ID
        && !region_id.starts_with(crate::cache::STAGING_REGION_PREFIX)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Validate the generated warm job identifier before using caller input as an in-memory map key.
pub fn valid_job_id(job_id: &str) -> bool {
    let Some(rest) = job_id.strip_prefix("warm-") else {
        return false;
    };
    let Some((boot_id, order)) = rest.rsplit_once('-') else {
        return false;
    };
    boot_id.len() == 32
        && boot_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        && !order.is_empty()
        && order.len() <= 20
        && order.bytes().all(|byte| byte.is_ascii_digit())
        && order.parse::<u64>().is_ok()
}

/// Validate the request, create the job, spawn the warm driver, and return the job id.
pub async fn start_warm(state: &AppState, req: WarmRequest) -> Result<String, StartError> {
    let _config_guard = state.config_update.lock().await;
    if state.shutdown_requested.load(Ordering::Acquire) {
        return Err(StartError::ShuttingDown);
    }
    if req.sources.is_empty() || req.sources.len() > MAX_WARM_SOURCES {
        return Err(StartError::UnknownSource("no sources".into()));
    }
    if req.minzoom > req.maxzoom {
        return Err(StartError::BadZoom(format!(
            "minzoom {} > maxzoom {}",
            req.minzoom, req.maxzoom
        )));
    }
    let mut bboxes = vec![req.bbox];
    if let Some(bbox) = req.additional_bbox {
        bboxes.push(bbox);
    }
    if bboxes.iter().any(|b| {
        !b.iter().all(|v| v.is_finite())
            || b[0] < -180.0
            || b[0] > 180.0
            || b[2] < -180.0
            || b[2] > 180.0
            || b[1] < -90.0
            || b[1] > 90.0
            || b[3] < -90.0
            || b[3] > 90.0
            || b[0] == b[2]
            || (b[0] > b[2] && (b[0] - b[2]).abs() == 360.0)
            || b[1] >= b[3]
    }) {
        return Err(StartError::BadBbox(format!("invalid bbox set {bboxes:?}")));
    }
    if req
        .region_id
        .as_deref()
        .is_some_and(|id| !valid_region_id(id))
    {
        return Err(StartError::BadRegion(
            "invalid or reserved region id".into(),
        ));
    }
    // Every distinct source must be in the allowlist; duplicate ids do not multiply work.
    let mut total = 0u64;
    let mut style_sources = 0usize;
    let mut requested_ids = std::collections::HashSet::new();
    {
        let map = state.sources.read().await;
        for s in &req.sources {
            if !requested_ids.insert(s.id.clone()) {
                continue;
            }
            match map.get(&s.id) {
                Some(known) if matches!(known.upstream, UpstreamTemplate::Style { .. }) => {
                    style_sources += 1;
                    if style_sources > 1 {
                        return Err(StartError::MultipleStyleSources);
                    }
                    // The style is not fetched yet, so count one sub-source's worth at the registry
                    // vector maxzoom for the hard-cap gate; run() enumerates each learned sub-source.
                    let clamp = known
                        .vector_maxzoom
                        .unwrap_or(known.maxzoom)
                        .min(known.maxzoom);
                    let mut tmp = known.clone();
                    tmp.maxzoom = clamp;
                    total += bboxes
                        .iter()
                        .map(|b| tile_count_in_bbox(&tmp, *b, req.minzoom, req.maxzoom))
                        .sum::<u64>();
                }
                Some(known) => {
                    total += bboxes
                        .iter()
                        .map(|b| tile_count_in_bbox(known, *b, req.minzoom, req.maxzoom))
                        .sum::<u64>();
                }
                None => return Err(StartError::UnknownSource(s.id.clone())),
            }
        }
    }
    if total == 0 {
        return Err(StartError::BadBbox(
            "bbox does not intersect the selected sources".into(),
        ));
    }
    if total > WARM_TILE_HARD_CAP {
        return Err(StartError::TooMany(total));
    }

    if let Some(region_id) = req.region_id.as_ref() {
        let mut active = state.active_warm_regions.lock().await;
        if !active.insert(region_id.clone()) {
            return Err(StartError::RegionBusy);
        }
    }

    let order = state.warm_seq.fetch_add(1, Ordering::Relaxed);
    let id = format!("warm-{}-{order}", state.boot_id);
    let cancel = Arc::new(AtomicBool::new(false));
    let job = Arc::new(tokio::sync::Mutex::new(WarmJob {
        total,
        done: 0,
        skipped: 0,
        bytes: 0,
        errors: 0,
        state: WarmState::Running,
        cancel: cancel.clone(),
        finished_at: None,
        region_id: req.region_id.clone(),
        created_at: now_secs(),
        order,
    }));
    {
        let mut jobs = state.warm_jobs.write().await;
        reap(&mut jobs);
        // Count and insert under the write lock so the cap check and the insert are atomic with
        // respect to other concurrent start_warm calls.
        let active = jobs
            .values()
            .filter(|j| {
                match j.try_lock() {
                    Ok(g) => g.state == WarmState::Running,
                    Err(_) => true, // locked by the driver mid-run: treat as running
                }
            })
            .count();
        if active >= MAX_ACTIVE_WARM_JOBS {
            if let Some(region_id) = req.region_id.as_ref() {
                state.active_warm_regions.lock().await.remove(region_id);
            }
            return Err(StartError::TooManyJobs);
        }
        jobs.insert(id.clone(), job.clone());
    }
    // Resolve the allowlisted source definitions (not the client-sent ones) so the warm uses the trusted config.
    let resolved: Vec<ChartSource> = {
        let map = state.sources.read().await;
        let mut seen = std::collections::HashSet::new();
        req.sources
            .iter()
            .filter(|source| seen.insert(source.id.clone()))
            .filter_map(|s| map.get(&s.id).cloned())
            .collect()
    };
    let st = state.clone();
    state.warm_task_count.fetch_add(1, Ordering::AcqRel);
    tokio::spawn(run(
        st,
        job,
        RunSpec {
            sources: resolved,
            bboxes,
            zmin: req.minzoom,
            zmax: req.maxzoom,
            region_id: req.region_id,
            job_id: id.clone(),
            config_generation: state.config_generation.load(Ordering::Acquire),
        },
    ));
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

/// Return the newest retained warm for a region, including its id, so a client can recover after the
/// POST was accepted but its response was lost.
pub async fn warm_snapshot_for_region(
    state: &AppState,
    region_id: &str,
) -> Option<serde_json::Value> {
    let jobs: Vec<(String, Arc<tokio::sync::Mutex<WarmJob>>)> = state
        .warm_jobs
        .read()
        .await
        .iter()
        .map(|(id, job)| (id.clone(), job.clone()))
        .collect();
    let mut newest: Option<(String, u64, serde_json::Value)> = None;
    for (job_id, job) in jobs {
        let job = job.lock().await;
        if job.region_id.as_deref() != Some(region_id) {
            continue;
        }
        let snapshot = serde_json::json!({
            "jobId": job_id.clone(),
            "total": job.total,
            "done": job.done,
            "skipped": job.skipped,
            "bytes": job.bytes,
            "errors": job.errors,
            "state": job.state,
        });
        if newest
            .as_ref()
            .is_none_or(|(_, order, _)| job.order > *order)
        {
            newest = Some((job_id, job.order, snapshot));
        }
    }
    newest.map(|(_, _, snapshot)| snapshot)
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

pub async fn cancel_all_warms(state: &AppState) {
    state.shutdown_requested.store(true, Ordering::Release);
    let jobs: Vec<_> = state.warm_jobs.read().await.values().cloned().collect();
    for job in jobs {
        job.lock().await.cancel.store(true, Ordering::Release);
    }
}

pub async fn wait_for_warms(state: &AppState, timeout: std::time::Duration) -> bool {
    tokio::time::timeout(timeout, async {
        loop {
            let notified = state.warm_task_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if state.warm_task_count.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
    })
    .await
    .is_ok()
}

/// Cancel every running warm for a logical region and wait until its driver has stopped writing.
/// Returns false if cancellation does not drain within the bounded wait.
pub async fn cancel_region_warms(state: &AppState, region_id: &str) -> bool {
    let jobs: Vec<Arc<tokio::sync::Mutex<WarmJob>>> =
        state.warm_jobs.read().await.values().cloned().collect();
    for job in jobs {
        let guard = job.lock().await;
        if guard.region_id.as_deref() == Some(region_id) && guard.state == WarmState::Running {
            guard.cancel.store(true, Ordering::Relaxed);
        }
    }
    // Return before the plugin's eight-second container request timeout. The driver normally drains
    // in one polling interval; the bounded wait covers slow SQLite cleanup without leaving the HTTP
    // caller hanging indefinitely.
    for _ in 0..120 {
        if !state.active_warm_regions.lock().await.contains(region_id) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}

async fn acquire_warm_permit(
    state: &AppState,
    cancel: &AtomicBool,
) -> Option<tokio::sync::OwnedSemaphorePermit> {
    loop {
        if cancel.load(Ordering::Acquire) || state.shutdown_requested.load(Ordering::Acquire) {
            return None;
        }
        match tokio::time::timeout(
            std::time::Duration::from_millis(50),
            state.warm_semaphore.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => return Some(permit),
            Ok(Err(_)) => return None,
            Err(_) => {}
        }
    }
}

// Drop finished jobs older than the TTL so the in-memory registry does not grow without bound.
fn reap(jobs: &mut std::collections::HashMap<String, Arc<tokio::sync::Mutex<WarmJob>>>) {
    let now = now_secs();
    jobs.retain(|_, j| match j.try_lock() {
        Ok(g) => g
            .finished_at
            .map(|t| now - t < WARM_JOB_TTL_SECS)
            .unwrap_or(true),
        Err(_) => true,
    });
    if jobs.len() <= MAX_RETAINED_WARM_JOBS {
        return;
    }
    let mut finished: Vec<(String, u64)> = jobs
        .iter()
        .filter_map(|(id, job)| {
            let guard = job.try_lock().ok()?;
            guard.finished_at.map(|_| (id.clone(), guard.order))
        })
        .collect();
    finished.sort_by_key(|(_, order)| *order);
    for (id, _) in finished
        .into_iter()
        .take(jobs.len().saturating_sub(MAX_RETAINED_WARM_JOBS))
    {
        jobs.remove(&id);
    }
}

enum Fetched {
    Tile(WarmRow),
    Negative(WarmRow),
    Skipped,
    Capped,
    Error,
    Cancelled,
}

struct RunSpec {
    sources: Vec<ChartSource>,
    bboxes: Vec<[f64; 4]>,
    zmin: u32,
    zmax: u32,
    region_id: Option<String>,
    job_id: String,
    config_generation: u64,
}

struct WarmTaskGuard(AppState);

impl Drop for WarmTaskGuard {
    fn drop(&mut self) {
        self.0.warm_task_count.fetch_sub(1, Ordering::AcqRel);
        self.0.warm_task_notify.notify_waiters();
    }
}

#[derive(Clone)]
struct WarmRegionContext {
    target: Option<Arc<str>>,
    storage: Option<Arc<str>>,
    replacement_credit: i64,
}

// The effective pinned budget for a warm: R for the position-warm pseudo-region, R - P for a real
// region (and for a region-less warm). Clamped to the live cap so R <= cap holds inside the container
// regardless of what POST /config delivered, and floored at 0. Read live so a POST /config retune
// takes effect mid-run.
fn effective_budget(st: &AppState, region_id: Option<&str>) -> i64 {
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    let r = st.live_regions_budget.load(Ordering::Relaxed);
    let p = st.live_position_warm_budget.load(Ordering::Relaxed);
    let raw = if region_id == Some(crate::state::POSITION_WARM_REGION_ID) {
        p
    } else {
        r - p
    };
    raw.min(cap).max(0)
}

fn replacement_budget(st: &AppState, region_id: Option<&str>, credit: i64) -> i64 {
    effective_budget(st, region_id)
        .saturating_add(credit.max(0))
        .min(st.live_cap_bytes.load(Ordering::Relaxed).max(0))
}

// Expand a style source into one synthetic XYZ sub-source per learned in-style source. The cache key
// includes the configuration generation so a warm writes the exact key the vector-tile serve route
// reads without allowing old style assets to bleed into a new configuration. Each sub-source is
// clamped to the minimum of the registry vector_maxzoom and the learned source maxzoom, so the
// enumeration never requests a tile above what the upstream serves. A non-style source passes through
// unchanged.
async fn expand_warm_sources(
    st: &AppState,
    sources: Vec<ChartSource>,
) -> Result<Vec<ChartSource>, ()> {
    let mut out = Vec::new();
    for source in sources {
        if !matches!(source.upstream, UpstreamTemplate::Style { .. }) {
            out.push(source);
            continue;
        }
        if !crate::style::ensure_style_learned(st, &source.id).await {
            eprintln!("event=warm_style_learn_failed source={}", source.id);
            return Err(());
        }
        let learned = { st.style_state.read().await.get(&source.id).cloned() };
        let Some(learned) = learned else {
            eprintln!(
                "tilecache: warm: style source {} learned but has no state; its basemap tiles are omitted",
                source.id
            );
            return Err(());
        };
        if learned.source_tiles.is_empty() {
            return Err(());
        }
        let registry_max = source.vector_maxzoom.unwrap_or(source.maxzoom);
        for (name, templates) in &learned.source_tiles {
            let Some(template) = templates.first() else {
                continue;
            };
            let native = learned
                .source_maxzoom
                .get(name)
                .copied()
                .unwrap_or(registry_max);
            out.push(ChartSource {
                id: crate::style::vector_cache_source_at(&source.id, name, learned.generation),
                title: source.title.clone(),
                upstream: UpstreamTemplate::Xyz {
                    url_template: template.clone(),
                },
                tile_size: source.tile_size,
                minzoom: source.minzoom,
                maxzoom: registry_max.min(native),
                vector_maxzoom: None,
                bounds: source.bounds,
                coverage: source.coverage.clone(),
                attribution: source.attribution.clone(),
            });
        }
    }
    if out.is_empty() {
        Err(())
    } else {
        Ok(out)
    }
}

// Glyph codepoint ranges to warm: U+0000 through U+2FFF in 256-wide blocks (48 ranges), enough for
// Latin, Greek, and Cyrillic map labels without paying for the full CJK range.
const GLYPH_RANGE_END: u32 = 12288;
const GLYPH_RANGE_STEP: u32 = 256;

// Resets the single-flight flag on every exit path (early return, panic, or normal completion).
struct AssetsFlag<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for AssetsFlag<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

// Flush a batch of assets pinned under the given region, additive (no delete_region). The assets warm
// does not touch the region job, so this calls put_many_pinned directly. A capped result is logged.
async fn flush_pinned(st: &AppState, batch: &mut Vec<WarmRow>, region: &str, budget: i64) -> bool {
    let now = now_secs();
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    // A capped outcome (the assets did not all fit under the budget) is dropped here; the next basemap
    // warm completes the set cache-first. Runs on the blocking pool so the batched write and its eviction
    // scan do not stall the reactor.
    let cache = st.cache.clone();
    let rows = std::mem::take(batch);
    let rows_len = rows.len();
    let region_owned = region.to_string();
    match tokio::task::spawn_blocking(move || {
        cache.put_many_pinned(&rows, budget, cap, Some(&region_owned), now)
    })
    .await
    {
        Ok(Ok(outcome)) if !outcome.capped && outcome.stored == rows_len => true,
        Ok(Ok(outcome)) => {
            eprintln!(
                "event=basemap_assets_capped stored={} requested={} capped={}",
                outcome.stored, rows_len, outcome.capped
            );
            false
        }
        Ok(Err(error)) => {
            eprintln!("event=cache_write_failed operation=assets_flush error={error}");
            false
        }
        Err(e) => {
            eprintln!("event=cache_task_failed operation=assets_flush error={e}");
            false
        }
    }
}

// Warm one asset (a glyph range or a sprite variant) cache-first: return None when it is already
// fresh-pinned, host-blocked, or a miss, else fetch it (host-checked, status-returning) and return a
// WarmRow with the synthetic key. Builds the WarmRow directly rather than through warm_one because the
// sprite JSON is rejected by the tile content-type gate. The caller holds the warm-semaphore permit for
// this task (like warm_one), so this does not take one.
struct WarmAssetSpec<'a> {
    cache_source: &'a str,
    x: u32,
    url: &'a str,
    kind: crate::style::StyleAssetKind,
    allowed: &'a [String],
    region: &'a str,
}

async fn warm_one_asset(
    st: &AppState,
    spec: WarmAssetSpec<'_>,
    cancel: Arc<AtomicBool>,
) -> Result<Option<WarmRow>, ()> {
    let WarmAssetSpec {
        cache_source,
        x,
        url,
        kind,
        allowed,
        region,
    } = spec;
    if cancel.load(Ordering::Acquire) || st.shutdown_requested.load(Ordering::Acquire) {
        return Err(());
    }
    let now = now_secs();
    // Skip-but-pin a fresh cached asset under one lock, on the blocking pool so the warm's SQLite does not
    // stall the reactor.
    let cached_asset_is_safe = match st.cache_get(cache_source, 0, x, 0).await {
        Ok(Some(tile)) if tile.status == 200 => crate::style::valid_style_asset(
            kind,
            &tile.content_type,
            tile.blob.as_deref().unwrap_or_default(),
        ),
        Ok(_) => true,
        Err(_) => false,
    };
    if cached_asset_is_safe {
        let cache = st.cache.clone();
        let cache_source_owned = cache_source.to_string();
        let region_owned = region.to_string();
        let fresh_secs = st.knobs.fresh_secs;
        let neg_ttl = st.knobs.negative_ttl_secs;
        let budget = effective_budget(st, Some(region));
        let st_cap = st.live_cap_bytes.load(Ordering::Relaxed);
        let pinned = tokio::task::spawn_blocking(move || {
            cache.pin_if_fresh_capped(
                TileKey::new(&cache_source_owned, 0, x, 0),
                now,
                fresh_secs,
                neg_ttl,
                PinBudgets {
                    category_bytes: budget,
                    physical_bytes: st_cap,
                },
                Some(&region_owned),
            )
        })
        .await;
        match pinned {
            Ok(Ok(FreshPinOutcome::Pinned)) => return Ok(None),
            Ok(Ok(FreshPinOutcome::MissingOrStale)) => {}
            Ok(Ok(FreshPinOutcome::Capped)) => return Err(()),
            Ok(Err(e)) => {
                eprintln!("tilecache: assets pin_if_fresh failed: {e}");
                return Err(());
            }
            Err(e) => {
                eprintln!("tilecache: assets pin_if_fresh task failed: {e}");
                return Err(());
            }
        }
    }
    if !crate::style::style_url_allowed(url, allowed, st.knobs.allow_private_egress) {
        return Err(());
    }
    // A missing asset (404 or 204) is not pinned: a pinned negative is never evicted, so it would
    // permanently mask a glyph range or sprite variant the upstream later begins serving. Leaving it
    // uncached lets the next basemap warm and the live route refetch it, so only a 200 is stored.
    let fetch = crate::fetcher::fetch_upstream(st, cache_source, url, None);
    tokio::pin!(fetch);
    let fetched = loop {
        tokio::select! {
            result = &mut fetch => break Some(result),
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                if cancel.load(Ordering::Acquire) || st.shutdown_requested.load(Ordering::Acquire) {
                    break None;
                }
            }
        }
    };
    match fetched {
        None => Err(()),
        Some(Ok((200, f))) => {
            if !crate::style::valid_style_asset(kind, &f.content_type, &f.body) {
                eprintln!("tilecache: warm asset {url} returned an unsafe body; skipped");
                return Err(());
            }
            let fetched_at = now_secs();
            Ok(Some(WarmRow {
                source: cache_source.to_string(),
                z: 0,
                x,
                y: 0,
                tile: CachedTile {
                    content_type: f.content_type,
                    strong_etag: crate::fetcher::strong_etag(&f.body),
                    upstream_validator: f.validator,
                    status: 200,
                    fetched_at,
                    last_access: fetched_at,
                    bytes: f.body.len() as i64,
                    blob: Some(f.body),
                },
            }))
        }
        // A 404 or 204 is an expected sparse-coverage miss (left uncached above); anything else is a
        // fetch failure worth a log line, matching the other warm fetch paths in this file.
        Some(Ok((404, _))) | Some(Ok((204, _))) => Ok(None),
        Some(Ok((status, _))) => {
            eprintln!("tilecache: warm asset {url} returned status {status}; skipped");
            Err(())
        }
        Some(Err(_)) => {
            eprintln!("tilecache: warm asset {url} fetch failed (offline or blocked); skipped");
            Err(())
        }
    }
}

// Warm the global basemap glyphs and the sprite once, cache-first per key, pinned under
// __basemap_assets__. Single-flight via the AppState flag (reset on every exit by the RAII guard).
// Each asset is skipped when already fresh-pinned, so this is idempotent and recovers a partial set.
// It never touches the region job's counters and bounds its fan-out through the warm semaphore.
async fn stage_basemap_assets(
    st: &AppState,
    style_source: &str,
    job_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<String, ()> {
    loop {
        if st
            .assets_warming
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            break;
        }
        if cancel.load(Ordering::Acquire) || st.shutdown_requested.load(Ordering::Acquire) {
            return Err(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let _flag = AssetsFlag(&st.assets_warming);
    if cancel.load(Ordering::Acquire) || st.shutdown_requested.load(Ordering::Acquire) {
        return Err(());
    }

    let target_region = crate::state::BASEMAP_ASSETS_REGION_ID;
    let region = format!("{}assets-{job_id}", crate::cache::STAGING_REGION_PREFIX);
    let replacement_credit = {
        let cache = st.cache.clone();
        tokio::task::spawn_blocking(move || cache.region_bytes(target_region).unwrap_or(0))
            .await
            .unwrap_or(0)
    };
    let budget = replacement_budget(st, Some(target_region), replacement_credit);
    // Snapshot the learned templates and the allowed hosts, then drop the read guards before fetching.
    let (glyph_template, fontstacks, sprite_base, allowed, generation) = {
        let ss = st.style_state.read().await;
        let Some(s) = ss.get(style_source) else {
            return Err(());
        };
        let allowed = match st
            .sources
            .read()
            .await
            .get(style_source)
            .map(|c| c.upstream.clone())
        {
            Some(UpstreamTemplate::Style { allowed_hosts, .. }) => allowed_hosts,
            _ => return Err(()),
        };
        (
            s.glyphs.clone(),
            s.fontstacks.clone(),
            s.sprite_base.clone(),
            allowed,
            s.generation,
        )
    };

    // Build the full asset job list (each glyph range per fontstack, plus the sprite variants) as
    // (cache_source, synthetic x, upstream URL, asset kind) tuples. The cache_source is shared through
    // an Arc so a
    // fontstack's 48 ranges (and the 4 sprite variants) reuse one allocation rather than cloning the
    // String per job.
    let mut jobs: Vec<(Arc<str>, u32, String, crate::style::StyleAssetKind)> = Vec::new();
    if let Some(template) = glyph_template {
        for fontstack in &fontstacks {
            let cache_source: Arc<str> = Arc::from(crate::style::glyph_cache_source_at(
                style_source,
                fontstack,
                generation,
            ));
            for range_start in (0..GLYPH_RANGE_END).step_by(GLYPH_RANGE_STEP as usize) {
                let range = format!("{range_start}-{}.pbf", range_start + GLYPH_RANGE_STEP - 1);
                let url = crate::style::expand_glyph_url(&template, fontstack, &range);
                jobs.push((
                    cache_source.clone(),
                    range_start,
                    url,
                    crate::style::StyleAssetKind::Glyph,
                ));
            }
        }
    }
    if let Some(base) = sprite_base {
        let cache_source: Arc<str> = Arc::from(crate::style::sprite_cache_source_at(
            style_source,
            generation,
        ));
        for (idx, suffix) in crate::style::SPRITE_VARIANTS {
            let kind = if suffix.ends_with(".json") {
                crate::style::StyleAssetKind::SpriteJson
            } else {
                crate::style::StyleAssetKind::SpritePng
            };
            jobs.push((cache_source.clone(), idx, format!("{base}{suffix}"), kind));
        }
    }

    // Fetch the assets through a JoinSet bounded by the warm semaphore (the same fan-out the tile warm
    // uses), collecting the fetched rows into batches that flush at WARM_BATCH. Serial before, so a
    // fontstack's 48 glyph ranges each blocked on the prior fetch.
    let allowed = Arc::new(allowed);
    let region_arc: Arc<str> = Arc::from(region.as_str());
    let mut batch: Vec<WarmRow> = Vec::with_capacity(WARM_BATCH);
    let mut set: tokio::task::JoinSet<Result<Option<WarmRow>, ()>> = tokio::task::JoinSet::new();
    let mut success = true;
    for (cache_source, x, url, kind) in jobs {
        let permit = match acquire_warm_permit(st, &cancel).await {
            Some(permit) => permit,
            None => {
                success = false;
                break;
            }
        };
        let st2 = st.clone();
        let allowed2 = allowed.clone();
        let region2 = region_arc.clone();
        let task_cancel = cancel.clone();
        set.spawn(async move {
            let _permit = permit;
            warm_one_asset(
                &st2,
                WarmAssetSpec {
                    cache_source: &cache_source,
                    x,
                    url: &url,
                    kind,
                    allowed: &allowed2,
                    region: &region2,
                },
                task_cancel,
            )
            .await
        });
        while let Some(done) = set.try_join_next() {
            match done {
                Ok(Ok(Some(row))) => {
                    success &= push_and_maybe_flush(st, &mut batch, &region, budget, row).await;
                }
                Ok(Ok(None)) => {}
                Ok(Err(())) | Err(_) => {
                    success = false;
                    break;
                }
            }
        }
        if !success {
            break;
        }
    }
    while let Some(done) = set.join_next().await {
        match done {
            Ok(Ok(Some(row))) => {
                success &= push_and_maybe_flush(st, &mut batch, &region, budget, row).await;
            }
            Ok(Ok(None)) => {}
            Ok(Err(())) | Err(_) => success = false,
        }
    }
    if cancel.load(Ordering::Acquire) || st.shutdown_requested.load(Ordering::Acquire) {
        success = false;
    }
    if success && !batch.is_empty() {
        success &= flush_pinned(st, &mut batch, &region, budget).await;
    }
    if !success {
        let cache = st.cache.clone();
        let staging = region.clone();
        let _ = tokio::task::spawn_blocking(move || cache.delete_region(&staging)).await;
        return Err(());
    }
    Ok(region)
}

fn warm_batch_should_flush(batch: &[WarmRow]) -> bool {
    batch.len() >= WARM_BATCH
        || batch.iter().map(|row| row.tile.bytes.max(0)).sum::<i64>() >= WARM_BATCH_BYTES
}

// Push a fetched asset row into the batch, flushing the batch when it reaches either the row or byte
// bound. Shared by the two JoinSet drain loops so the push-and-flush step lives in one place.
async fn push_and_maybe_flush(
    st: &AppState,
    batch: &mut Vec<WarmRow>,
    region: &str,
    budget: i64,
    row: WarmRow,
) -> bool {
    batch.push(row);
    if warm_batch_should_flush(batch) {
        flush_pinned(st, batch, region, budget).await
    } else {
        true
    }
}

// Fetch and classify one tile, reusing the guarded egress path. The caller holds the warm permit, so
// this does not take it; guarded_get still takes an egress permit inside.
async fn warm_one(
    st: &AppState,
    source: &ChartSource,
    z: u32,
    x: u32,
    y: u32,
    region: &WarmRegionContext,
    cancel: Arc<AtomicBool>,
) -> Fetched {
    let now = now_secs();
    // pin_if_fresh does the freshness check, the budget gate, and the pin under one lock, closing the
    // race where a concurrent evict_to could delete the row between a separate get() and pin() call. It
    // runs on the blocking pool so the warm's synchronous SQLite does not stall the async reactor.
    let cache = st.cache.clone();
    let source_id = source.id.clone();
    let region_owned = region.storage.as_deref().map(str::to_string);
    let fresh_secs = st.knobs.fresh_secs;
    let neg_ttl = st.knobs.negative_ttl_secs;
    let budget = replacement_budget(st, region.target.as_deref(), region.replacement_credit);
    let st_cap = st.live_cap_bytes.load(Ordering::Relaxed);
    let pinned = tokio::task::spawn_blocking(move || {
        cache.pin_if_fresh_capped(
            TileKey::new(&source_id, z, x, y),
            now,
            fresh_secs,
            neg_ttl,
            PinBudgets {
                category_bytes: budget,
                physical_bytes: st_cap,
            },
            region_owned.as_deref(),
        )
    })
    .await;
    match pinned {
        Ok(Ok(FreshPinOutcome::Pinned)) => return Fetched::Skipped,
        Ok(Ok(FreshPinOutcome::MissingOrStale)) => {}
        Ok(Ok(FreshPinOutcome::Capped)) => return Fetched::Capped,
        Ok(Err(e)) => eprintln!("tilecache: warm pin_if_fresh failed: {e}"),
        Err(e) => eprintln!("tilecache: warm pin_if_fresh task failed: {e}"),
    }
    // Share the same per-key flight as live tile and style routes. Re-check after taking it because a
    // live request or overlapping warm may have stored and pinned the tile while this task waited.
    let flight_key = crate::fetcher::inflight_key(&source.id, z, x, y);
    let Some(flight) = st.inflight_lock(&flight_key).await else {
        return Fetched::Error;
    };
    let _flight_guard = flight.lock().await;
    let cache = st.cache.clone();
    let source_id = source.id.clone();
    let region_owned = region.storage.as_deref().map(str::to_string);
    let fresh_secs = st.knobs.fresh_secs;
    let neg_ttl = st.knobs.negative_ttl_secs;
    let budget = replacement_budget(st, region.target.as_deref(), region.replacement_credit);
    let st_cap = st.live_cap_bytes.load(Ordering::Relaxed);
    match tokio::task::spawn_blocking(move || {
        cache.pin_if_fresh_capped(
            TileKey::new(&source_id, z, x, y),
            now_secs(),
            fresh_secs,
            neg_ttl,
            PinBudgets {
                category_bytes: budget,
                physical_bytes: st_cap,
            },
            region_owned.as_deref(),
        )
    })
    .await
    {
        Ok(Ok(FreshPinOutcome::Pinned)) => {
            st.inflight_finish(&flight_key, &flight).await;
            return Fetched::Skipped;
        }
        Ok(Ok(FreshPinOutcome::Capped)) => {
            st.inflight_finish(&flight_key, &flight).await;
            return Fetched::Capped;
        }
        Ok(Ok(FreshPinOutcome::MissingOrStale)) => {}
        Ok(Err(error)) => eprintln!("event=warm_pin_recheck_failed error={error}"),
        Err(error) => eprintln!("event=warm_pin_recheck_task_failed error={error}"),
    }
    let url = match expand_upstream(source, z, x, y) {
        Ok(u) => u,
        Err(_) => {
            st.inflight_finish(&flight_key, &flight).await;
            return Fetched::Error;
        }
    };
    let fetch = fetch_upstream(st, &source.id, &url, None);
    tokio::pin!(fetch);
    let fetched = loop {
        tokio::select! {
            result = &mut fetch => break Some(result),
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                if cancel.load(Ordering::Acquire) || st.shutdown_requested.load(Ordering::Acquire) {
                    break None;
                }
            }
        }
    };
    let result = match fetched {
        None => Fetched::Cancelled,
        Some(Ok((200, f))) => {
            if f.body.len() > st.knobs.max_blob_bytes || !acceptable_content_type(&f.content_type) {
                Fetched::Error
            } else {
                let fetched_at = now_secs();
                Fetched::Tile(WarmRow {
                    source: source.id.clone(),
                    z,
                    x,
                    y,
                    tile: CachedTile {
                        content_type: f.content_type,
                        strong_etag: strong_etag(&f.body),
                        upstream_validator: f.validator,
                        status: 200,
                        fetched_at,
                        last_access: fetched_at,
                        bytes: f.body.len() as i64,
                        blob: Some(f.body),
                    },
                })
            }
        }
        Some(Ok((404, _))) | Some(Ok((204, _))) => {
            let fetched_at = now_secs();
            Fetched::Negative(WarmRow {
                source: source.id.clone(),
                z,
                x,
                y,
                tile: CachedTile::negative(404, fetched_at),
            })
        }
        Some(_) => Fetched::Error,
    };
    st.inflight_finish(&flight_key, &flight).await;
    result
}

// The warm driver: enumerate lazily, bound in-flight fetches to WARM_CONCURRENCY via owned permits and a
// JoinSet, drain results into a batch, and flush each batch pinned with the pre-store budget check.
async fn run(st: AppState, job: Arc<tokio::sync::Mutex<WarmJob>>, spec: RunSpec) {
    let _task_guard = WarmTaskGuard(st.clone());
    let RunSpec {
        sources,
        bboxes,
        zmin,
        zmax,
        region_id,
        job_id,
        config_generation,
    } = spec;
    if st.config_generation.load(Ordering::Acquire) != config_generation {
        let mut job = job.lock().await;
        job.state = WarmState::Error;
        job.finished_at = Some(now_secs());
        drop(job);
        if let Some(region_id) = region_id.as_ref() {
            st.active_warm_regions.lock().await.remove(region_id);
        }
        return;
    }
    // A replacement downloads into a job-specific staging region. The last known-good target remains
    // pinned until every requested tile has completed and the staging set can be promoted atomically.
    let staging_region_id = region_id.as_ref().map(|region| {
        if region == crate::state::POSITION_WARM_REGION_ID {
            format!("{}{job_id}", crate::cache::POSITION_STAGING_REGION_PREFIX)
        } else {
            format!("{}{job_id}", crate::cache::STAGING_REGION_PREFIX)
        }
    });
    let replacement_credit = if let Some(rid) = region_id.clone() {
        let cache = st.cache.clone();
        tokio::task::spawn_blocking(move || cache.region_bytes(&rid).unwrap_or(0))
            .await
            .unwrap_or(0)
    } else {
        0
    };
    let region_context = WarmRegionContext {
        target: region_id.as_deref().map(Arc::from),
        storage: staging_region_id.as_deref().map(Arc::from),
        replacement_credit,
    };
    // Capture the style source (if any) before expansion replaces it with synthetic XYZ sub-sources,
    // so the folded assets warm can look up the learned glyph template, fontstacks, and sprite base.
    let style_source_id: Option<String> = sources
        .iter()
        .find(|s| matches!(s.upstream, UpstreamTemplate::Style { .. }))
        .map(|s| s.id.clone());
    // Expand any style source into generation-aware synthetic XYZ sub-sources (learning the style
    // once), so the enumeration and the pin path below run unchanged for the basemap.
    let sources = match expand_warm_sources(&st, sources).await {
        Ok(sources) => sources,
        Err(()) => {
            let mut job = job.lock().await;
            job.errors += 1;
            job.state = WarmState::Error;
            job.finished_at = Some(now_secs());
            drop(job);
            if let Some(region_id) = region_id.as_ref() {
                st.active_warm_regions.lock().await.remove(region_id);
            }
            return;
        }
    };
    // Re-gate on the true enumerated total now that a style source has expanded into one sub-source per
    // in-style source: the pre-spawn hard-cap check in start_warm counts a style as a single sub-source,
    // so a multi-source style could otherwise enumerate past WARM_TILE_HARD_CAP. Also correct the job
    // total to the real expanded count so progress is accurate.
    let expanded_total: u64 = sources
        .iter()
        .flat_map(|s| {
            bboxes
                .iter()
                .map(move |bbox| tile_count_in_bbox(s, *bbox, zmin, zmax))
        })
        .sum();
    if expanded_total == 0 || expanded_total > WARM_TILE_HARD_CAP {
        eprintln!("tilecache: warm expanded to {expanded_total} tiles, over the {WARM_TILE_HARD_CAP} hard cap; aborting");
        let mut j = job.lock().await;
        j.total = expanded_total;
        j.state = WarmState::Error;
        j.finished_at = Some(now_secs());
        drop(j);
        if let Some(region_id) = region_id.as_ref() {
            st.active_warm_regions.lock().await.remove(region_id);
        }
        return;
    }
    job.lock().await.total = expanded_total;
    let cancel = { job.lock().await.cancel.clone() };
    let mut set: tokio::task::JoinSet<Fetched> = tokio::task::JoinSet::new();
    let mut batch: Vec<WarmRow> = Vec::with_capacity(WARM_BATCH);
    let mut final_state = WarmState::Done;

    // Enumerate tiles lazily via tiles_iter, with only the disjoint coverage ranges allocated, and
    // spawn bounded tasks. The cancel check between tiles keeps the cooperative cancel responsive.
    // The source and region_id are shared through an Arc so each of the up-to-WARM_TILE_HARD_CAP spawns
    // costs a refcount bump, not a full ChartSource plus String clone per tile.
    'outer: for source in &sources {
        let source_arc = Arc::new(source.clone());
        for bbox in &bboxes {
            for (z, x, y) in tiles_iter(source, *bbox, zmin, zmax) {
                if st.config_generation.load(Ordering::Acquire) != config_generation {
                    final_state = WarmState::Error;
                    break 'outer;
                }
                if cancel.load(Ordering::Relaxed) {
                    final_state = WarmState::Cancelled;
                    break 'outer;
                }
                let permit = match acquire_warm_permit(&st, &cancel).await {
                    Some(permit) => permit,
                    None => {
                        final_state = if cancel.load(Ordering::Relaxed) {
                            WarmState::Cancelled
                        } else {
                            WarmState::Error
                        };
                        break 'outer;
                    }
                };
                let st2 = st.clone();
                let source2 = source_arc.clone();
                let region = region_context.clone();
                let task_cancel = cancel.clone();
                set.spawn(async move {
                    let _permit = permit;
                    warm_one(&st2, &source2, z, x, y, &region, task_cancel).await
                });
                // Drain any finished tasks without blocking, keeping memory flat.
                while let Some(done) = set.try_join_next() {
                    match done {
                        Ok(f) => {
                            if !accumulate(
                                &st,
                                &job,
                                &mut batch,
                                f,
                                &region_context,
                                &mut final_state,
                            )
                            .await
                            {
                                cancel.store(true, Ordering::Relaxed);
                                break 'outer;
                            }
                        }
                        Err(error) => {
                            eprintln!("event=warm_task_failed error={error}");
                            job.lock().await.errors += 1;
                            final_state = WarmState::Error;
                            cancel.store(true, Ordering::Relaxed);
                            break 'outer;
                        }
                    }
                }
            }
        }
    }
    // Join remaining in-flight tasks.
    loop {
        if cancel.load(Ordering::Relaxed) && final_state == WarmState::Done {
            final_state = WarmState::Cancelled;
        }
        let done = match tokio::time::timeout(std::time::Duration::from_millis(50), set.join_next())
            .await
        {
            Ok(Some(done)) => done,
            Ok(None) => break,
            Err(_) => continue,
        };
        match done {
            Ok(f) if final_state == WarmState::Done => {
                if !accumulate(&st, &job, &mut batch, f, &region_context, &mut final_state).await {
                    cancel.store(true, Ordering::Relaxed);
                }
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!("event=warm_task_failed error={error}");
                job.lock().await.errors += 1;
                final_state = WarmState::Error;
            }
        }
    }
    if final_state == WarmState::Done && job.lock().await.errors > 0 {
        final_state = WarmState::Error;
    }
    // Flush the tail.
    if final_state == WarmState::Done && !batch.is_empty() {
        flush(
            &st,
            &job,
            &mut batch,
            region_context.target.as_deref(),
            region_context.storage.as_deref(),
            region_context.replacement_credit,
            &mut final_state,
        )
        .await;
    }
    if final_state == WarmState::Done && job.lock().await.errors > 0 {
        final_state = WarmState::Error;
    }
    if final_state == WarmState::Done {
        let progress = job.lock().await;
        if progress.done.saturating_add(progress.skipped) != progress.total {
            eprintln!(
                "event=warm_incomplete done={} skipped={} total={}",
                progress.done, progress.skipped, progress.total
            );
            final_state = WarmState::Error;
        }
    }

    // Stage required assets only after every tile batch has succeeded. Their target and the saved-region
    // target are promoted in one SQLite transaction so neither last-known-good set can advance alone.
    let mut asset_staging: Option<String> = None;
    if final_state == WarmState::Done
        && st.config_generation.load(Ordering::Acquire) != config_generation
    {
        final_state = WarmState::Error;
    }
    if final_state == WarmState::Done {
        if let Some(style_id) = style_source_id.as_deref() {
            match stage_basemap_assets(&st, style_id, &job_id, cancel.clone()).await {
                Ok(staging) => asset_staging = Some(staging),
                Err(()) => {
                    if cancel.load(Ordering::Acquire) {
                        final_state = WarmState::Cancelled;
                    } else {
                        job.lock().await.errors += 1;
                        final_state = WarmState::Error;
                    }
                }
            }
        }
    }
    let mut replacements = Vec::new();
    if let (Some(staging), Some(target)) = (staging_region_id.clone(), region_id.clone()) {
        replacements.push((staging, target));
    }
    if let Some(staging) = asset_staging.clone() {
        replacements.push((staging, crate::state::BASEMAP_ASSETS_REGION_ID.to_string()));
    }
    if final_state == WarmState::Done
        && st.config_generation.load(Ordering::Acquire) != config_generation
    {
        final_state = WarmState::Error;
    }
    let promotion_config_guard = if final_state == WarmState::Done && !replacements.is_empty() {
        Some(st.config_update.lock().await)
    } else {
        None
    };
    if promotion_config_guard.is_some()
        && st.config_generation.load(Ordering::Acquire) != config_generation
    {
        final_state = WarmState::Error;
    }
    if final_state == WarmState::Done && !replacements.is_empty() {
        let cache = st.cache.clone();
        let replacements_for_task = replacements.clone();
        let cap = st.live_cap_bytes.load(Ordering::Relaxed).max(0);
        let regions = st
            .live_regions_budget
            .load(Ordering::Relaxed)
            .min(cap)
            .max(0);
        let position = st
            .live_position_warm_budget
            .load(Ordering::Relaxed)
            .min(regions)
            .max(0);
        match tokio::task::spawn_blocking(move || {
            cache.promote_staged_regions(
                &replacements_for_task,
                (regions - position).max(0),
                position,
                cap,
            )
        })
        .await
        {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => final_state = WarmState::Capped,
            Ok(Err(error)) => {
                eprintln!("event=cache_region_promote_failed error={error}");
                final_state = WarmState::Error;
            }
            Err(error) => {
                eprintln!("event=cache_task_failed operation=region_promote error={error}");
                final_state = WarmState::Error;
            }
        }
    }
    drop(promotion_config_guard);
    if final_state != WarmState::Done {
        for (staging, _) in replacements {
            let cache = st.cache.clone();
            match tokio::task::spawn_blocking(move || cache.delete_region(&staging)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("event=cache_staging_cleanup_failed error={error}"),
                Err(error) => {
                    eprintln!("event=cache_task_failed operation=staging_cleanup error={error}")
                }
            }
        }
    }
    {
        let mut j = job.lock().await;
        j.state = final_state;
        j.finished_at = Some(now_secs());
    }
    if let Some(region_id) = region_id.as_ref() {
        st.active_warm_regions.lock().await.remove(region_id);
    }
}

// Apply one fetch result to the batch and the counters. Returns false when a flush reports capped.
async fn accumulate(
    st: &AppState,
    job: &Arc<tokio::sync::Mutex<WarmJob>>,
    batch: &mut Vec<WarmRow>,
    f: Fetched,
    region: &WarmRegionContext,
    final_state: &mut WarmState,
) -> bool {
    match f {
        Fetched::Tile(row) | Fetched::Negative(row) => {
            batch.push(row);
            if warm_batch_should_flush(batch) {
                return flush(
                    st,
                    job,
                    batch,
                    region.target.as_deref(),
                    region.storage.as_deref(),
                    region.replacement_credit,
                    final_state,
                )
                .await;
            }
            true
        }
        Fetched::Skipped => {
            job.lock().await.skipped += 1;
            true
        }
        Fetched::Capped => {
            *final_state = WarmState::Capped;
            false
        }
        Fetched::Error => {
            job.lock().await.errors += 1;
            true
        }
        Fetched::Cancelled => {
            *final_state = WarmState::Cancelled;
            false
        }
    }
}

// Store the current batch pinned, with the pre-store budget check. Returns false when capped.
async fn flush(
    st: &AppState,
    job: &Arc<tokio::sync::Mutex<WarmJob>>,
    batch: &mut Vec<WarmRow>,
    budget_region_id: Option<&str>,
    storage_region_id: Option<&str>,
    replacement_credit: i64,
    final_state: &mut WarmState,
) -> bool {
    let now = now_secs();
    // The batched pinned write and its make-room eviction scan run on the blocking pool so the warm's
    // synchronous SQLite does not stall the async reactor.
    let cache = st.cache.clone();
    let rows = std::mem::take(batch);
    let budget = replacement_budget(st, budget_region_id, replacement_credit);
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    let region_owned = storage_region_id.map(str::to_string);
    let result = tokio::task::spawn_blocking(move || {
        cache.put_many_pinned(&rows, budget, cap, region_owned.as_deref(), now)
    })
    .await;
    match result {
        Ok(Ok(outcome)) => {
            let mut j = job.lock().await;
            j.done += outcome.stored as u64;
            j.bytes += outcome.bytes_added;
            if outcome.capped {
                *final_state = WarmState::Capped;
                return false;
            }
            true
        }
        Ok(Err(e)) => {
            eprintln!("tilecache: warm flush failed: {e}");
            job.lock().await.errors += 1;
            true
        }
        Err(e) => {
            eprintln!("tilecache: warm flush task failed: {e}");
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
    use axum::extract::Path;
    use axum::http::header;
    use axum::response::IntoResponse;
    use axum::{routing::get, Router};
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tempfile::NamedTempFile;
    use tokio::net::TcpListener;

    async fn stub() -> SocketAddr {
        let app = Router::new()
            .route(
                "/img/{z}/{x}/{y}",
                get(|| async { ([(header::CONTENT_TYPE, "image/png")], vec![1u8, 2, 3, 4]) }),
            )
            .route(
                "/missing/{z}/{x}/{y}",
                get(|| async { axum::http::StatusCode::NOT_FOUND }),
            )
            .route(
                "/error/{z}/{x}/{y}",
                get(|| async { axum::http::StatusCode::INTERNAL_SERVER_ERROR }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    fn xyz(addr: SocketAddr, path: &str) -> ChartSource {
        ChartSource {
            id: "s".into(),
            title: "S".into(),
            upstream: UpstreamTemplate::Xyz {
                url_template: format!("http://{addr}/{path}/{{z}}/{{x}}/{{y}}"),
            },
            tile_size: 256,
            minzoom: 0,
            maxzoom: 4,
            vector_maxzoom: None,
            bounds: None,
            coverage: None,
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
        Knobs {
            allow_private_egress: true,
            ..Default::default()
        }
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
        // A real region's R - P slice clamps to the cap.
        assert_eq!(
            effective_budget(&st, Some("r1")),
            1000,
            "R - P clamps to the cap"
        );
        // The position-warm pseudo-region receives only P, so P = 0 disables it independently of R.
        assert_eq!(
            effective_budget(&st, Some(crate::state::POSITION_WARM_REGION_ID)),
            0,
            "position warm uses P, not R",
        );
        st.live_position_warm_budget.store(5000, Ordering::Relaxed);
        assert_eq!(
            effective_budget(&st, Some(crate::state::POSITION_WARM_REGION_ID)),
            1000,
            "P clamps to the cap",
        );
        // A negative R - P floors at 0.
        st.live_regions_budget.store(100, Ordering::Relaxed);
        st.live_position_warm_budget.store(500, Ordering::Relaxed);
        assert_eq!(effective_budget(&st, Some("r1")), 0, "R - P floors at 0");
    }

    #[test]
    fn byte_threshold_flushes_before_a_large_warm_batch_exhausts_memory() {
        let row = |x, bytes| WarmRow {
            source: "s".into(),
            z: 0,
            x,
            y: 0,
            tile: CachedTile {
                content_type: "image/png".into(),
                strong_etag: String::new(),
                upstream_validator: None,
                status: 200,
                fetched_at: 0,
                last_access: 0,
                bytes,
                blob: None,
            },
        };
        let mut batch = vec![row(0, WARM_BATCH_BYTES - 1)];
        assert!(!warm_batch_should_flush(&batch));
        batch.push(row(1, 1));
        assert!(
            warm_batch_should_flush(&batch),
            "the byte threshold flushes well before the 64-row bound",
        );
    }

    #[tokio::test]
    async fn warm_asset_fetch_rejects_active_types_and_malformed_sprite_json() {
        let app = Router::new()
            .route(
                "/bad-json",
                get(|| async { ([(header::CONTENT_TYPE, "application/json")], "{bad") }),
            )
            .route(
                "/bad-png",
                get(|| async { ([(header::CONTENT_TYPE, "image/svg+xml")], "<svg/>") }),
            )
            .route(
                "/bad-glyph",
                get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<script/>") }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let allowed = vec!["127.0.0.1".to_string()];
        for (x, path, kind) in [
            (0, "bad-json", crate::style::StyleAssetKind::SpriteJson),
            (1, "bad-png", crate::style::StyleAssetKind::SpritePng),
            (2, "bad-glyph", crate::style::StyleAssetKind::Glyph),
        ] {
            let result = warm_one_asset(
                &st,
                WarmAssetSpec {
                    cache_source: "unsafe-assets",
                    x,
                    url: &format!("http://{addr}/{path}"),
                    kind,
                    allowed: &allowed,
                    region: "r1",
                },
                Arc::new(AtomicBool::new(false)),
            )
            .await;
            assert!(result.is_err(), "{path}");
            assert!(
                st.cache
                    .get(TileKey::new("unsafe-assets", 0, x, 0))
                    .unwrap()
                    .is_none(),
                "{path} was not cached"
            );
        }
    }

    #[tokio::test]
    async fn region_recovery_uses_monotonic_order_for_same_second_jobs() {
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(stub().await, "img")).await;
        let make_job = |order| {
            Arc::new(tokio::sync::Mutex::new(WarmJob {
                total: order,
                done: 0,
                skipped: 0,
                bytes: 0,
                errors: 0,
                state: WarmState::Done,
                cancel: Arc::new(AtomicBool::new(false)),
                finished_at: Some(42),
                region_id: Some("same-region".into()),
                created_at: 42,
                order,
            }))
        };
        st.warm_jobs
            .write()
            .await
            .insert("older".into(), make_job(7));
        st.warm_jobs
            .write()
            .await
            .insert("newer".into(), make_job(8));
        let snapshot = warm_snapshot_for_region(&st, "same-region").await.unwrap();
        assert_eq!(snapshot["jobId"], "newer");
    }

    #[tokio::test]
    async fn warm_start_waits_for_a_coherent_config_generation() {
        let address = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(address, "img")).await;
        let guard = st.config_update.lock().await;
        let task_state = st.clone();
        let source = st.sources.read().await["s"].clone();
        let start = tokio::spawn(async move {
            start_warm(
                &task_state,
                WarmRequest {
                    sources: vec![source],
                    bbox: [-1.0, -1.0, 1.0, 1.0],
                    additional_bbox: None,
                    minzoom: 0,
                    maxzoom: 0,
                    region_id: Some("serialized".into()),
                },
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            st.warm_jobs.read().await.is_empty(),
            "no job captures an in-progress config update",
        );
        drop(guard);
        let job_id = start.await.unwrap().unwrap();
        assert_eq!(wait_done(&st, &job_id).await["state"], "done");
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
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-10.0, -10.0, 10.0, 10.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 1,
                region_id: None,
            },
        )
        .await
        .unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "done");
        assert!(snap["done"].as_u64().unwrap() >= 1);
        // The stored tile is pinned: an evict_to far below the total leaves it.
        st.cache.evict_to(0).unwrap();
        assert!(
            st.cache.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "the warmed box is pinned"
        );
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
            content_type: "image/png".into(),
            strong_etag: "x".into(),
            upstream_validator: None,
            status: 200,
            fetched_at: now,
            last_access: now,
            bytes: 4,
            blob: Some(vec![1, 2, 3, 4].into()),
        };
        st.cache
            .put(TileKey::new("s", 0, 0, 0), &seeded, false, now)
            .unwrap();
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-10.0, -10.0, 10.0, 10.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: None,
            },
        )
        .await
        .unwrap();
        let snap = wait_done(&st, &job).await;
        assert!(
            snap["skipped"].as_u64().unwrap() >= 1,
            "the fresh tile is skipped, not refetched"
        );
        st.cache.evict_to(0).unwrap();
        assert!(
            st.cache.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "the skipped tile was pinned by the warm"
        );
    }

    #[tokio::test]
    async fn warm_marks_capped_and_does_not_evict() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        // cap below one tile (4 bytes) so the first sized put trips the cap.
        let st = state(
            &db,
            Knobs {
                cap_bytes: 2,
                allow_private_egress: true,
                ..Default::default()
            },
            xyz(addr, "img"),
        )
        .await;
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-10.0, -10.0, 10.0, 10.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: None,
            },
        )
        .await
        .unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "capped");
        assert_eq!(
            st.cache.stats().unwrap().1,
            0,
            "nothing stored, nothing evicted"
        );
    }

    #[tokio::test]
    async fn warm_rejects_an_unknown_source_and_an_oversize_count() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let known = st.sources.read().await["s"].clone();
        let mut unknown = known.clone();
        unknown.id = "nope".into();
        assert!(matches!(
            start_warm(
                &st,
                WarmRequest {
                    sources: vec![unknown],
                    bbox: [-1.0, -1.0, 1.0, 1.0],
                    additional_bbox: None,
                    minzoom: 0,
                    maxzoom: 0,
                    region_id: None
                }
            )
            .await,
            Err(StartError::UnknownSource(_))
        ));
        assert!(matches!(
            start_warm(
                &st,
                WarmRequest {
                    sources: vec![known.clone()],
                    bbox: [10.0, 10.0, 5.0, 5.0],
                    additional_bbox: None,
                    minzoom: 0,
                    maxzoom: 0,
                    region_id: None
                }
            )
            .await,
            Err(StartError::BadBbox(_))
        ));
        let mut outside = known.clone();
        outside.id = "outside".into();
        outside.coverage = Some(vec![[100.0, 40.0, 110.0, 50.0]]);
        st.sources
            .write()
            .await
            .insert(outside.id.clone(), outside.clone());
        assert!(matches!(
            start_warm(
                &st,
                WarmRequest {
                    sources: vec![outside],
                    bbox: [-1.0, -1.0, 1.0, 1.0],
                    additional_bbox: None,
                    minzoom: 0,
                    maxzoom: 0,
                    region_id: Some("region".into())
                }
            )
            .await,
            Err(StartError::BadBbox(_))
        ));
        // A source with a deep max zoom over the whole world projects past WARM_TILE_HARD_CAP (2_000_000):
        // zoom 11 alone is 4^11 = 4_194_304 tiles, so start_warm rejects it upfront with TooMany. Replace
        // the stored "s" with a deep-zoom copy so start_warm resolves the real (deep) source for the count.
        let mut deep = known.clone();
        deep.maxzoom = 12;
        st.sources
            .write()
            .await
            .insert(deep.id.clone(), deep.clone());
        assert!(matches!(
            start_warm(
                &st,
                WarmRequest {
                    sources: vec![deep],
                    bbox: [-180.0, -85.0, 180.0, 85.0],
                    additional_bbox: None,
                    minzoom: 0,
                    maxzoom: 12,
                    region_id: None
                }
            )
            .await,
            Err(StartError::TooMany(_))
        ));
    }

    #[tokio::test]
    async fn one_warm_job_counts_both_antimeridian_boxes() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let source = st.sources.read().await["s"].clone();
        let west = [179.9, -1.0, 180.0, 1.0];
        let east = [-180.0, -1.0, -179.9, 1.0];
        let expected = crate::geom::tile_count_in_bbox(&source, west, 1, 1)
            + crate::geom::tile_count_in_bbox(&source, east, 1, 1);
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![source],
                bbox: west,
                additional_bbox: Some(east),
                minzoom: 1,
                maxzoom: 1,
                region_id: None,
            },
        )
        .await
        .unwrap();
        let snapshot = warm_snapshot(&st, &job).await.unwrap();
        assert_eq!(snapshot["total"].as_u64().unwrap(), expected);
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
            WarmRequest {
                sources: vec![src.clone()],
                bbox: [-180.0, -90.0, 180.0, 90.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: None,
            },
        )
        .await;
        assert!(
            result.is_ok(),
            "beyond-limit latitude must not produce BadBbox: {result:?}"
        );
        let job_id = result.unwrap();
        let snap = wait_done(&st, &job_id).await;
        assert_eq!(snap["state"], "done", "job must finish done");
        // total must match what tile_count_in_bbox reports for the same raw bbox (clip clamps both).
        let expected = crate::geom::tile_count_in_bbox(&src, [-180.0, -90.0, 180.0, 90.0], 0, 0);
        assert_eq!(
            snap["total"].as_u64().unwrap(),
            expected,
            "total tiles mismatch: snap={} expected={expected}",
            snap["total"]
        );
    }

    #[tokio::test]
    async fn concurrent_job_cap_rejects_excess_starts() {
        // Use a slow stub so all MAX_ACTIVE_WARM_JOBS jobs stay Running while we attempt the extra one.
        let app = axum::Router::new().route(
            "/slow/{z}/{x}/{y}",
            get(|| async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                ([(header::CONTENT_TYPE, "image/png")], vec![1u8, 2, 3, 4])
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
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
            let job = start_warm(
                &st,
                WarmRequest {
                    sources: vec![st.sources.read().await["s"].clone()],
                    bbox: [-180.0, -85.0, 180.0, 85.0],
                    additional_bbox: None,
                    minzoom: 0,
                    maxzoom: 4,
                    region_id: None,
                },
            )
            .await
            .unwrap();
            ids.push(job);
        }

        // The (MAX_ACTIVE_WARM_JOBS + 1)th start must be rejected.
        let result = start_warm(
            &st,
            WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-1.0, -1.0, 1.0, 1.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: None,
            },
        )
        .await;
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
    async fn overlapping_warms_for_the_same_region_are_rejected_and_cancel_cleanly() {
        let app = axum::Router::new().route(
            "/slow/{z}/{x}/{y}",
            get(|| async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                ([(header::CONTENT_TYPE, "image/png")], vec![1u8, 2, 3, 4])
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "slow")).await;
        let source = st.sources.read().await["s"].clone();
        let request = || WarmRequest {
            sources: vec![source.clone()],
            bbox: [-1.0, -1.0, 1.0, 1.0],
            additional_bbox: None,
            minzoom: 0,
            maxzoom: 0,
            region_id: Some("region".into()),
        };
        let first = start_warm(&st, request()).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let second = start_warm(&st, request()).await;
        assert!(matches!(second, Err(StartError::RegionBusy)));

        assert!(cancel_region_warms(&st, "region").await);
        let snap = wait_done(&st, &first).await;
        assert_eq!(snap["state"], "cancelled");
        assert!(!st.active_warm_regions.lock().await.contains("region"));
    }

    #[tokio::test]
    async fn a_failed_replacement_preserves_the_last_good_region() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let source = st.sources.read().await["s"].clone();
        let initial = start_warm(
            &st,
            WarmRequest {
                sources: vec![source],
                bbox: [-1.0, -1.0, 1.0, 1.0],
                additional_bbox: None,
                minzoom: 1,
                maxzoom: 1,
                region_id: Some("region".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(wait_done(&st, &initial).await["state"], "done");
        let before = st.cache.region_bytes("region").unwrap();
        assert!(before > 0);

        {
            let mut sources = st.sources.write().await;
            sources.insert("s".into(), xyz(addr, "error"));
        }
        let replacement = start_warm(
            &st,
            WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-1.0, -1.0, 1.0, 1.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: Some("region".into()),
            },
        )
        .await
        .unwrap();
        let snap = wait_done(&st, &replacement).await;
        assert_eq!(snap["state"], "error");
        assert!(snap["errors"].as_u64().unwrap() > 0);
        assert_eq!(st.cache.region_bytes("region").unwrap(), before);
        assert_eq!(
            st.cache
                .region_bytes(&format!("__warm_staging__{replacement}"))
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn warm_cancel_stops_between_tiles() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-180.0, -85.0, 180.0, 85.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 4,
                region_id: None,
            },
        )
        .await
        .unwrap();
        assert!(cancel_warm(&st, &job).await);
        let snap = wait_done(&st, &job).await;
        assert!(snap["state"] == "cancelled" || snap["state"] == "done");
    }

    async fn style_stub() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let a = addr;
        let app = Router::new()
            .route("/style", get(move || async move {
                ([(header::CONTENT_TYPE, "application/json")], format!(
                    r#"{{"version":8,"sources":{{"openmaptiles":{{"type":"vector","url":"http://{a}/tiles.json"}}}},"layers":[]}}"#))
            }))
            .route("/tiles.json", get(move || async move {
                ([(header::CONTENT_TYPE, "application/json")], format!(r#"{{"tiles":["http://{a}/t/{{z}}/{{x}}/{{y}}.pbf"],"maxzoom":14}}"#))
            }))
            .route("/t/{z}/{x}/{y}", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![8u8, 8, 8, 8]) }));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    fn style_source(addr: SocketAddr) -> ChartSource {
        ChartSource {
            id: "basemap".into(),
            title: "B".into(),
            upstream: UpstreamTemplate::Style {
                style_url: format!("http://{addr}/style"),
                allowed_hosts: vec!["127.0.0.1".into()],
            },
            tile_size: 256,
            minzoom: 0,
            maxzoom: 20,
            vector_maxzoom: Some(14),
            bounds: None,
            coverage: None,
            attribution: String::new(),
        }
    }

    #[tokio::test]
    async fn warm_rejects_multiple_style_sources_before_asset_staging() {
        let addr = style_stub().await;
        let db = NamedTempFile::new().unwrap();
        let first = style_source(addr);
        let st = state(&db, dev(), first.clone()).await;
        let mut second = first.clone();
        second.id = "second-basemap".into();
        st.sources
            .write()
            .await
            .insert(second.id.clone(), second.clone());

        let result = start_warm(
            &st,
            WarmRequest {
                sources: vec![first, second],
                bbox: [-1.0, -1.0, 1.0, 1.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 1,
                region_id: Some("r1".into()),
            },
        )
        .await;
        assert!(matches!(result, Err(StartError::MultipleStyleSources)));
        assert!(st.warm_jobs.read().await.is_empty());
        assert!(st.active_warm_regions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn warm_pins_basemap_vector_tiles_under_the_style_cache_key() {
        let addr = style_stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        let src = st.sources.read().await["basemap"].clone();
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![src],
                bbox: [-1.0, -1.0, 1.0, 1.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 2,
                region_id: Some("r1".into()),
            },
        )
        .await
        .unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "done");
        assert!(
            snap["done"].as_u64().unwrap() >= 1,
            "at least one vector tile warmed"
        );
        st.cache.evict_to(0).unwrap();
        let generation = st.style_state.read().await["basemap"].generation;
        let vector_key =
            crate::style::vector_cache_source_at("basemap", "openmaptiles", generation);
        assert!(
            st.cache
                .get(TileKey::new(&vector_key, 0, 0, 0))
                .unwrap()
                .is_some(),
            "the basemap vector tile is pinned under the style cache key"
        );
    }

    #[tokio::test]
    async fn warm_clamps_basemap_to_the_native_maxzoom() {
        let addr = style_stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        let src = st.sources.read().await["basemap"].clone();
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![src],
                bbox: [-0.01, -0.01, 0.01, 0.01],
                additional_bbox: None,
                minzoom: 14,
                maxzoom: 16,
                region_id: Some("r1".into()),
            },
        )
        .await
        .unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "done");
        let generation = st.style_state.read().await["basemap"].generation;
        let vector_key =
            crate::style::vector_cache_source_at("basemap", "openmaptiles", generation);
        assert!(
            st.cache
                .get(TileKey::new(&vector_key, 15, 0, 0))
                .unwrap()
                .is_none(),
            "no tile above the native maxzoom"
        );
    }

    async fn style_stub_with_assets() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let a = addr;
        let app = Router::new()
            .route("/style", get(move || async move {
                ([(header::CONTENT_TYPE, "application/json")], format!(
                    r#"{{"version":8,"glyphs":"http://{a}/fonts/{{fontstack}}/{{range}}.pbf","sprite":"http://{a}/sprites/ofm","sources":{{"openmaptiles":{{"type":"vector","url":"http://{a}/tiles.json"}}}},"layers":[{{"id":"l","type":"symbol","layout":{{"text-font":["Noto Sans Regular"]}}}}]}}"#))
            }))
            .route("/tiles.json", get(move || async move {
                ([(header::CONTENT_TYPE, "application/json")], format!(r#"{{"tiles":["http://{a}/t/{{z}}/{{x}}/{{y}}.pbf"],"maxzoom":14}}"#))
            }))
            .route("/t/{z}/{x}/{y}", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![8u8, 8, 8, 8]) }))
            .route("/fonts/{fontstack}/{range}", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![7u8, 7, 7]) }))
            .route(
                "/sprites/{name}",
                get(|Path(name): Path<String>| async move {
                    if name.ends_with(".png") {
                        ([(header::CONTENT_TYPE, "image/png")], vec![137, 80, 78, 71])
                            .into_response()
                    } else {
                        (
                            [(header::CONTENT_TYPE, "application/json")],
                            r#"{"ok":1}"#,
                        )
                            .into_response()
                    }
                }),
            );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    async fn style_stub_with_slow_assets(started: Arc<AtomicBool>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let a = addr;
        let glyph_started = started.clone();
        let app = Router::new()
            .route(
                "/style",
                get(move || async move {
                    ([(header::CONTENT_TYPE, "application/json")], format!(
                        r#"{{"version":8,"glyphs":"http://{a}/fonts/{{fontstack}}/{{range}}.pbf","sources":{{"openmaptiles":{{"type":"vector","url":"http://{a}/tiles.json"}}}},"layers":[{{"id":"l","type":"symbol","layout":{{"text-font":["Noto Sans Regular"]}}}}]}}"#))
                }),
            )
            .route(
                "/tiles.json",
                get(move || async move {
                    ([(header::CONTENT_TYPE, "application/json")], format!(r#"{{"tiles":["http://{a}/t/{{z}}/{{x}}/{{y}}.pbf"],"maxzoom":14}}"#))
                }),
            )
            .route(
                "/t/{z}/{x}/{y}",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "application/x-protobuf")],
                        vec![8u8; 4],
                    )
                }),
            )
            .route(
                "/fonts/{fontstack}/{range}",
                get(move || {
                    let started = glyph_started.clone();
                    async move {
                        started.store(true, Ordering::Release);
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        (
                            [(header::CONTENT_TYPE, "application/x-protobuf")],
                            vec![7u8; 3],
                        )
                    }
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    #[tokio::test]
    async fn cancellation_interrupts_slow_asset_staging_and_cleans_staging() {
        let started = Arc::new(AtomicBool::new(false));
        let addr = style_stub_with_slow_assets(started.clone()).await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        let source = st.sources.read().await["basemap"].clone();
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![source],
                bbox: [-0.5, -0.5, 0.5, 0.5],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: Some("cancel-assets".into()),
            },
        )
        .await
        .unwrap();
        for _ in 0..200 {
            if started.load(Ordering::Acquire) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            started.load(Ordering::Acquire),
            "asset staging reached the slow provider"
        );
        let began = std::time::Instant::now();
        assert!(cancel_warm(&st, &job).await);
        let snapshot = wait_done(&st, &job).await;
        assert_eq!(snapshot["state"], "cancelled");
        assert!(
            began.elapsed() < std::time::Duration::from_secs(2),
            "cancellation does not wait for the 30-second asset response",
        );
        assert_eq!(st.cache.region_bytes("cancel-assets").unwrap(), 0);
        assert_eq!(
            st.cache
                .region_bytes(crate::state::BASEMAP_ASSETS_REGION_ID)
                .unwrap(),
            0,
        );
    }

    // Poll the assets region until it holds bytes. This also keeps the helper robust if completion
    // bookkeeping changes independently of the asset transaction.
    async fn wait_assets(st: &AppState) {
        for _ in 0..200 {
            if st
                .cache
                .region_bytes(crate::state::BASEMAP_ASSETS_REGION_ID)
                .unwrap()
                > 0
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("the basemap assets warm did not pin within the timeout");
    }

    #[tokio::test]
    async fn a_basemap_warm_pins_the_global_glyphs_and_sprite_once() {
        let addr = style_stub_with_assets().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        let src = st.sources.read().await["basemap"].clone();
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![src],
                bbox: [-0.5, -0.5, 0.5, 0.5],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: Some("r1".into()),
            },
        )
        .await
        .unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "done");
        wait_assets(&st).await;
        let generation = st.style_state.read().await["basemap"].generation;
        let gk = crate::style::glyph_cache_source_at("basemap", "Noto Sans Regular", generation);
        assert!(
            st.cache.get(TileKey::new(&gk, 0, 0, 0)).unwrap().is_some(),
            "a glyph range is pinned under the assets region"
        );
        let sk = crate::style::sprite_cache_source_at("basemap", generation);
        assert!(
            st.cache.get(TileKey::new(&sk, 0, 0, 0)).unwrap().is_some(),
            "the sprite json is pinned"
        );
        // Pinned: a deep eviction keeps them.
        st.cache.evict_to(0).unwrap();
        assert!(
            st.cache.get(TileKey::new(&gk, 0, 0, 0)).unwrap().is_some(),
            "the glyph is pinned, not evicted"
        );
    }

    #[tokio::test]
    async fn a_second_basemap_warm_adds_no_duplicate_asset_bytes() {
        let addr = style_stub_with_assets().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        let src = st.sources.read().await["basemap"].clone();
        let j1 = start_warm(
            &st,
            WarmRequest {
                sources: vec![src.clone()],
                bbox: [-0.5, -0.5, 0.5, 0.5],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: Some("r1".into()),
            },
        )
        .await
        .unwrap();
        wait_done(&st, &j1).await;
        wait_assets(&st).await;
        let after_first = st
            .cache
            .region_bytes(crate::state::BASEMAP_ASSETS_REGION_ID)
            .unwrap();
        let j2 = start_warm(
            &st,
            WarmRequest {
                sources: vec![src],
                bbox: [-0.5, -0.5, 0.5, 0.5],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: Some("r1".into()),
            },
        )
        .await
        .unwrap();
        wait_done(&st, &j2).await;
        // The second run is cache-first per key: no new fetch, no duplicate pinned bytes.
        let after_second = st
            .cache
            .region_bytes(crate::state::BASEMAP_ASSETS_REGION_ID)
            .unwrap();
        assert_eq!(
            after_first, after_second,
            "the second basemap warm adds no duplicate asset bytes"
        );
        assert!(after_first > 0);
    }

    #[tokio::test]
    async fn a_non_basemap_warm_pins_no_assets() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-1.0, -1.0, 1.0, 1.0],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: Some("r1".into()),
            },
        )
        .await
        .unwrap();
        wait_done(&st, &job).await;
        assert_eq!(
            st.cache
                .region_bytes(crate::state::BASEMAP_ASSETS_REGION_ID)
                .unwrap(),
            0,
            "a raster warm pins no basemap assets"
        );
    }

    #[tokio::test]
    async fn assets_warm_recovers_a_partial_set() {
        let addr = style_stub_with_assets().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        // Pre-pin one glyph range under the assets region (simulating a prior partial run); the warm
        // must skip it (cache-first) and fill the rest.
        let gk = crate::style::glyph_cache_source_at("basemap", "Noto Sans Regular", 0);
        let now = crate::state::now_secs();
        let seeded = CachedTile {
            content_type: "application/x-protobuf".into(),
            strong_etag: "s".into(),
            upstream_validator: None,
            status: 200,
            fetched_at: now,
            last_access: now,
            bytes: 3,
            blob: Some(vec![1u8, 2, 3].into()),
        };
        st.cache
            .put(TileKey::new(&gk, 0, 0, 0), &seeded, false, now)
            .unwrap();
        st.cache
            .pin_for_region(
                TileKey::new(&gk, 0, 0, 0),
                2_000_000_000,
                Some(crate::state::BASEMAP_ASSETS_REGION_ID),
            )
            .unwrap();
        let src = st.sources.read().await["basemap"].clone();
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![src],
                bbox: [-0.5, -0.5, 0.5, 0.5],
                additional_bbox: None,
                minzoom: 0,
                maxzoom: 0,
                region_id: Some("r1".into()),
            },
        )
        .await
        .unwrap();
        wait_done(&st, &job).await;
        // The seed already makes region_bytes non-zero, so poll the LATER range, not wait_assets, to
        // know the warm filled the rest.
        let mut filled = false;
        for _ in 0..200 {
            if st
                .cache
                .get(TileKey::new(&gk, 0, 256, 0))
                .unwrap()
                .is_some()
            {
                filled = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(filled, "a later glyph range was filled");
        // The seeded range keeps its seeded bytes (not refetched).
        assert_eq!(
            st.cache
                .get(TileKey::new(&gk, 0, 0, 0))
                .unwrap()
                .unwrap()
                .blob,
            Some(vec![1u8, 2, 3].into()),
            "the seeded glyph was not refetched"
        );
    }
}
