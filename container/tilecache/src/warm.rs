//! The warm-job engine: enumerate a bbox lazily with the shared inverse, fetch each tile through the
//! existing guarded egress path, and store it pinned in batched transactions. A warm never evicts a
//! pinned tile: it evicts unpinned scroll tiles to fit within the cap, with an explicit pre-store
//! budget check that stops at `capped` when the pinned set would exceed the regions budget. Fan-out is
//! bounded by a warm semaphore
//! below the shared `EGRESS_CONCURRENCY`, so a large warm cannot starve interactive tile reads. The job
//! registry is in memory, cleared on completion plus a TTL.

use crate::cache::{CachedTile, TileKey, WarmRow};
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
        return Err(StartError::BadZoom(format!(
            "minzoom {} > maxzoom {}",
            req.minzoom, req.maxzoom
        )));
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
                Some(known) if matches!(known.upstream, UpstreamTemplate::Style { .. }) => {
                    // The style is not fetched yet, so count one sub-source's worth at the registry
                    // vector maxzoom for the hard-cap gate; run() enumerates each learned sub-source.
                    let clamp = known
                        .vector_maxzoom
                        .unwrap_or(known.maxzoom)
                        .min(known.maxzoom);
                    let mut tmp = known.clone();
                    tmp.maxzoom = clamp;
                    total += tile_count_in_bbox(&tmp, b, req.minzoom, req.maxzoom);
                }
                Some(known) => {
                    total += tile_count_in_bbox(known, b, req.minzoom, req.maxzoom);
                }
                None => return Err(StartError::UnknownSource(s.id.clone())),
            }
        }
    }
    if total > WARM_TILE_HARD_CAP {
        return Err(StartError::TooMany(total));
    }

    let id = format!("warm-{}", state.warm_seq.fetch_add(1, Ordering::Relaxed));
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
            return Err(StartError::TooManyJobs);
        }
        jobs.insert(id.clone(), job.clone());
    }
    // Resolve the allowlisted source definitions (not the client-sent ones) so the warm uses the trusted config.
    let resolved: Vec<ChartSource> = {
        let map = state.sources.read().await;
        req.sources
            .iter()
            .filter_map(|s| map.get(&s.id).cloned())
            .collect()
    };
    let st = state.clone();
    tokio::spawn(run(
        st,
        job,
        resolved,
        b,
        req.minzoom,
        req.maxzoom,
        req.region_id,
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
        Ok(g) => g
            .finished_at
            .map(|t| now - t < WARM_JOB_TTL_SECS)
            .unwrap_or(true),
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
    let raw = if region_id == Some(crate::state::POSITION_WARM_REGION_ID) {
        r
    } else {
        r - p
    };
    raw.min(cap).max(0)
}

// Expand a style source into one synthetic XYZ sub-source per learned in-style source, keyed
// style:{source}:{name} so the warm writes the exact key the vector-tile serve route reads. Each
// sub-source is clamped to the minimum of the registry vector_maxzoom and the learned source maxzoom,
// so the enumeration never requests a tile above what the upstream serves. A non-style source passes
// through unchanged.
async fn expand_warm_sources(st: &AppState, sources: Vec<ChartSource>) -> (Vec<ChartSource>, u64) {
    let mut out = Vec::new();
    let mut failed = 0u64;
    for source in sources {
        if !matches!(source.upstream, UpstreamTemplate::Style { .. }) {
            out.push(source);
            continue;
        }
        if !crate::style::ensure_style_learned(st, &source.id).await {
            eprintln!(
                "tilecache: warm: style source {} failed to learn; its basemap tiles are omitted from this region",
                source.id
            );
            failed += 1;
            continue;
        }
        let learned = { st.style_state.read().await.get(&source.id).cloned() };
        let Some(learned) = learned else {
            eprintln!(
                "tilecache: warm: style source {} learned but has no state; its basemap tiles are omitted",
                source.id
            );
            failed += 1;
            continue;
        };
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
                id: format!("style:{}:{}", source.id, name),
                title: source.title.clone(),
                upstream: UpstreamTemplate::Xyz {
                    url_template: template.clone(),
                },
                tile_size: source.tile_size,
                minzoom: source.minzoom,
                maxzoom: registry_max.min(native),
                vector_maxzoom: None,
                bounds: None,
                attribution: source.attribution.clone(),
            });
        }
    }
    (out, failed)
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
async fn flush_pinned(st: &AppState, batch: &mut Vec<WarmRow>, region: &str) {
    let now = now_secs();
    let budget = effective_budget(st, Some(region));
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    // A capped outcome (the assets did not all fit under the budget) is dropped here; the next basemap
    // warm completes the set cache-first. Runs on the blocking pool so the batched write and its eviction
    // scan do not stall the reactor.
    let cache = st.cache.clone();
    let rows = std::mem::take(batch);
    let region_owned = region.to_string();
    match tokio::task::spawn_blocking(move || {
        cache.put_many_pinned(&rows, budget, cap, Some(&region_owned), now)
    })
    .await
    {
        Ok(r) => crate::fetcher::log_cache_err(r),
        Err(e) => eprintln!("tilecache: assets flush task failed: {e}"),
    }
}

// Warm one asset (a glyph range or a sprite variant) cache-first: return None when it is already
// fresh-pinned, host-blocked, or a miss, else fetch it (host-checked, status-returning) and return a
// WarmRow with the synthetic key. Builds the WarmRow directly rather than through warm_one because the
// sprite JSON is rejected by the tile content-type gate. The caller holds the warm-semaphore permit for
// this task (like warm_one), so this does not take one.
async fn warm_one_asset(
    st: &AppState,
    cache_source: &str,
    x: u32,
    url: &str,
    allowed: &[String],
    region: &str,
) -> Option<WarmRow> {
    let now = now_secs();
    // Skip-but-pin a fresh cached asset under one lock, on the blocking pool so the warm's SQLite does not
    // stall the reactor.
    let cache = st.cache.clone();
    let cache_source_owned = cache_source.to_string();
    let region_owned = region.to_string();
    let fresh_secs = st.knobs.fresh_secs;
    let neg_ttl = st.knobs.negative_ttl_secs;
    let budget = effective_budget(st, Some(region));
    let pinned = tokio::task::spawn_blocking(move || {
        cache.pin_if_fresh(
            TileKey::new(&cache_source_owned, 0, x, 0),
            now,
            fresh_secs,
            neg_ttl,
            budget,
            Some(&region_owned),
        )
    })
    .await;
    match pinned {
        Ok(Ok(true)) => return None,
        Ok(Ok(false)) => {}
        Ok(Err(e)) => eprintln!("tilecache: assets pin_if_fresh failed: {e}"),
        Err(e) => eprintln!("tilecache: assets pin_if_fresh task failed: {e}"),
    }
    if !crate::style::host_allowed(url, allowed) {
        return None;
    }
    // A missing asset (404 or 204) is not pinned: a pinned negative is never evicted, so it would
    // permanently mask a glyph range or sprite variant the upstream later begins serving. Leaving it
    // uncached lets the next basemap warm and the live route refetch it, so only a 200 is stored.
    match crate::fetcher::fetch_upstream(st, cache_source, url, None).await {
        Ok((200, f)) => Some(WarmRow {
            source: cache_source.to_string(),
            z: 0,
            x,
            y: 0,
            tile: CachedTile {
                content_type: f.content_type,
                strong_etag: crate::fetcher::strong_etag(&f.body),
                upstream_validator: None,
                status: 200,
                fetched_at: now,
                last_access: now,
                bytes: f.body.len() as i64,
                blob: Some(f.body),
            },
        }),
        // A 404 or 204 is an expected sparse-coverage miss (left uncached above); anything else is a
        // fetch failure worth a log line, matching the other warm fetch paths in this file.
        Ok((404, _)) | Ok((204, _)) => None,
        Ok((status, _)) => {
            eprintln!("tilecache: warm asset {url} returned status {status}; skipped");
            None
        }
        Err(_) => {
            eprintln!("tilecache: warm asset {url} fetch failed (offline or blocked); skipped");
            None
        }
    }
}

// Warm the global basemap glyphs and the sprite once, cache-first per key, pinned under
// __basemap_assets__. Single-flight via the AppState flag (reset on every exit by the RAII guard).
// Each asset is skipped when already fresh-pinned, so this is idempotent and recovers a partial set.
// It never touches the region job's counters and bounds its fan-out through the warm semaphore.
async fn warm_basemap_assets(st: &AppState, style_source: &str) {
    if st
        .assets_warming
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return; // another basemap warm is already fetching the set
    }
    let _flag = AssetsFlag(&st.assets_warming);

    let region = crate::state::BASEMAP_ASSETS_REGION_ID;
    // Snapshot the learned templates and the allowed hosts, then drop the read guards before fetching.
    let (glyph_template, fontstacks, sprite_base, allowed) = {
        let ss = st.style_state.read().await;
        let Some(s) = ss.get(style_source) else {
            return;
        };
        let allowed = match st
            .sources
            .read()
            .await
            .get(style_source)
            .map(|c| c.upstream.clone())
        {
            Some(UpstreamTemplate::Style { allowed_hosts, .. }) => allowed_hosts,
            _ => return,
        };
        (
            s.glyphs.clone(),
            s.fontstacks.clone(),
            s.sprite_base.clone(),
            allowed,
        )
    };

    // Build the full asset job list (each glyph range per fontstack, plus the sprite variants) as
    // (cache_source, synthetic x, upstream url) triples. The cache_source is shared through an Arc so a
    // fontstack's 48 ranges (and the 4 sprite variants) reuse one allocation rather than cloning the
    // String per job.
    let mut jobs: Vec<(Arc<str>, u32, String)> = Vec::new();
    if let Some(template) = glyph_template {
        for fontstack in &fontstacks {
            let cache_source: Arc<str> =
                Arc::from(crate::style::glyph_cache_source(style_source, fontstack));
            let encoded = crate::style::encode_fontstack(fontstack);
            for range_start in (0..GLYPH_RANGE_END).step_by(GLYPH_RANGE_STEP as usize) {
                let range = format!("{range_start}-{}.pbf", range_start + GLYPH_RANGE_STEP - 1);
                let url = template
                    .replace("{fontstack}", &encoded)
                    .replace("{range}.pbf", &range);
                jobs.push((cache_source.clone(), range_start, url));
            }
        }
    }
    if let Some(base) = sprite_base {
        let cache_source: Arc<str> = Arc::from(crate::style::sprite_cache_source(style_source));
        for (idx, suffix) in crate::style::SPRITE_VARIANTS {
            jobs.push((cache_source.clone(), idx, format!("{base}{suffix}")));
        }
    }

    // Fetch the assets through a JoinSet bounded by the warm semaphore (the same fan-out the tile warm
    // uses), collecting the fetched rows into batches that flush at WARM_BATCH. Serial before, so a
    // fontstack's 48 glyph ranges each blocked on the prior fetch.
    let allowed = Arc::new(allowed);
    let region_arc: Arc<str> = Arc::from(region);
    let mut batch: Vec<WarmRow> = Vec::with_capacity(WARM_BATCH);
    let mut set: tokio::task::JoinSet<Option<WarmRow>> = tokio::task::JoinSet::new();
    for (cache_source, x, url) in jobs {
        let permit = match st.warm_semaphore.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break,
        };
        let st2 = st.clone();
        let allowed2 = allowed.clone();
        let region2 = region_arc.clone();
        set.spawn(async move {
            let _permit = permit;
            warm_one_asset(&st2, &cache_source, x, &url, &allowed2, &region2).await
        });
        while let Some(done) = set.try_join_next() {
            if let Ok(Some(row)) = done {
                push_and_maybe_flush(st, &mut batch, region, row).await;
            }
        }
    }
    while let Some(done) = set.join_next().await {
        if let Ok(Some(row)) = done {
            push_and_maybe_flush(st, &mut batch, region, row).await;
        }
    }
    if !batch.is_empty() {
        flush_pinned(st, &mut batch, region).await;
    }
}

// Push a fetched asset row into the batch, flushing the batch pinned when it reaches WARM_BATCH. Shared
// by the two JoinSet drain loops in warm_basemap_assets so the push-and-flush step lives in one place.
async fn push_and_maybe_flush(st: &AppState, batch: &mut Vec<WarmRow>, region: &str, row: WarmRow) {
    batch.push(row);
    if batch.len() >= WARM_BATCH {
        flush_pinned(st, batch, region).await;
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
    region_id: Option<&str>,
) -> Fetched {
    let now = now_secs();
    // pin_if_fresh does the freshness check, the budget gate, and the pin under one lock, closing the
    // race where a concurrent evict_to could delete the row between a separate get() and pin() call. It
    // runs on the blocking pool so the warm's synchronous SQLite does not stall the async reactor.
    let cache = st.cache.clone();
    let source_id = source.id.clone();
    let region_owned = region_id.map(str::to_string);
    let fresh_secs = st.knobs.fresh_secs;
    let neg_ttl = st.knobs.negative_ttl_secs;
    let budget = effective_budget(st, region_id);
    let pinned = tokio::task::spawn_blocking(move || {
        cache.pin_if_fresh(
            TileKey::new(&source_id, z, x, y),
            now,
            fresh_secs,
            neg_ttl,
            budget,
            region_owned.as_deref(),
        )
    })
    .await;
    match pinned {
        Ok(Ok(true)) => return Fetched::Skipped,
        Ok(Ok(false)) => {} // absent, stale, or over budget: fall through to fetch (the flush gate decides)
        Ok(Err(e)) => eprintln!("tilecache: warm pin_if_fresh failed: {e}"),
        Err(e) => eprintln!("tilecache: warm pin_if_fresh task failed: {e}"),
    }
    let url = match expand_upstream(source, z, x, y) {
        Ok(u) => u,
        Err(_) => return Fetched::Error,
    };
    match fetch_upstream(st, &source.id, &url, None).await {
        Ok((200, f)) => {
            if f.body.len() > st.knobs.max_blob_bytes || !acceptable_content_type(&f.content_type) {
                return Fetched::Error;
            }
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
                    fetched_at: now,
                    last_access: now,
                    bytes: f.body.len() as i64,
                    blob: Some(f.body),
                },
            })
        }
        Ok((404, _)) | Ok((204, _)) => Fetched::Negative(WarmRow {
            source: source.id.clone(),
            z,
            x,
            y,
            tile: CachedTile::negative(404, now),
        }),
        _ => Fetched::Error,
    }
}

// The warm driver: enumerate lazily, bound in-flight fetches to WARM_CONCURRENCY via owned permits and a
// JoinSet, drain results into a batch, and flush each batch pinned with the pre-store budget check.
async fn run(
    st: AppState,
    job: Arc<tokio::sync::Mutex<WarmJob>>,
    sources: Vec<ChartSource>,
    bbox: [f64; 4],
    zmin: u32,
    zmax: u32,
    region_id: Option<String>,
) {
    // Clear this region's prior pins so a re-download or a position-warm re-pin replaces the prior tile
    // set with no orphan join rows (a narrower box leaves nothing pinned outside the new set).
    if let Some(rid) = region_id.clone() {
        let cache = st.cache.clone();
        match tokio::task::spawn_blocking(move || cache.delete_region(&rid)).await {
            Ok(r) => crate::fetcher::log_cache_err(r),
            Err(e) => eprintln!("tilecache: warm delete_region task failed: {e}"),
        }
    }
    // Capture the style source (if any) before expansion replaces it with synthetic XYZ sub-sources,
    // so the folded assets warm can look up the learned glyph template, fontstacks, and sprite base.
    let style_source_id: Option<String> = sources
        .iter()
        .find(|s| matches!(s.upstream, UpstreamTemplate::Style { .. }))
        .map(|s| s.id.clone());
    // Expand any style source into synthetic XYZ sub-sources keyed style:{source}:{name} (learning the
    // style once), so the enumeration and the pin path below run unchanged for the basemap.
    let (sources, style_learn_failures) = expand_warm_sources(&st, sources).await;
    // A style source that failed to learn is dropped from the enumeration, so record it as a job error;
    // otherwise the region reports Done with done == total and reads as fully cached when its basemap
    // never warmed and will not render offline.
    if style_learn_failures > 0 {
        job.lock().await.errors += style_learn_failures;
    }
    // Re-gate on the true enumerated total now that a style source has expanded into one sub-source per
    // in-style source: the pre-spawn hard-cap check in start_warm counts a style as a single sub-source,
    // so a multi-source style could otherwise enumerate past WARM_TILE_HARD_CAP. Also correct the job
    // total to the real expanded count so progress is accurate.
    let expanded_total: u64 = sources
        .iter()
        .map(|s| tile_count_in_bbox(s, bbox, zmin, zmax))
        .sum();
    if expanded_total > WARM_TILE_HARD_CAP {
        eprintln!("tilecache: warm expanded to {expanded_total} tiles, over the {WARM_TILE_HARD_CAP} hard cap; aborting");
        let mut j = job.lock().await;
        j.total = expanded_total;
        j.state = WarmState::Error;
        j.finished_at = Some(now_secs());
        return;
    }
    job.lock().await.total = expanded_total;
    let cancel = { job.lock().await.cancel.clone() };
    let mut set: tokio::task::JoinSet<Fetched> = tokio::task::JoinSet::new();
    let mut batch: Vec<WarmRow> = Vec::with_capacity(WARM_BATCH);
    let mut final_state = WarmState::Done;

    // Enumerate tiles lazily via tiles_iter (zero extra allocation beyond the iterator struct) and
    // spawn bounded tasks. The cancel check between tiles keeps the cooperative cancel responsive.
    // The source and region_id are shared through an Arc so each of the up-to-WARM_TILE_HARD_CAP spawns
    // costs a refcount bump, not a full ChartSource plus String clone per tile.
    let region_arc: Option<Arc<str>> = region_id.as_deref().map(Arc::from);
    'outer: for source in &sources {
        let source_arc = Arc::new(source.clone());
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
            let source2 = source_arc.clone();
            let rid = region_arc.clone();
            set.spawn(async move {
                let _permit = permit;
                warm_one(&st2, &source2, z, x, y, rid.as_deref()).await
            });
            // Drain any finished tasks without blocking, keeping memory flat.
            while let Some(done) = set.try_join_next() {
                if let Ok(f) = done {
                    if !accumulate(
                        &st,
                        &job,
                        &mut batch,
                        f,
                        region_id.as_deref(),
                        &mut final_state,
                    )
                    .await
                    {
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
            if final_state == WarmState::Done
                && !accumulate(
                    &st,
                    &job,
                    &mut batch,
                    f,
                    region_id.as_deref(),
                    &mut final_state,
                )
                .await
            {
                break;
            }
        }
    }
    // Flush the tail.
    if !batch.is_empty() {
        flush(
            &st,
            &job,
            &mut batch,
            region_id.as_deref(),
            &mut final_state,
        )
        .await;
    }
    {
        let mut j = job.lock().await;
        j.state = final_state;
        j.finished_at = Some(now_secs());
    }
    // Fold the one-time global assets warm in after a successful basemap region warm. The job is
    // already marked Done so the panel shows the region complete; the assets warm runs on this task
    // with its own counters and pins under __basemap_assets__.
    if final_state == WarmState::Done {
        if let Some(style_id) = style_source_id {
            warm_basemap_assets(&st, &style_id).await;
        }
    }
}

// Apply one fetch result to the batch and the counters. Returns false when a flush reports capped.
async fn accumulate(
    st: &AppState,
    job: &Arc<tokio::sync::Mutex<WarmJob>>,
    batch: &mut Vec<WarmRow>,
    f: Fetched,
    region_id: Option<&str>,
    final_state: &mut WarmState,
) -> bool {
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
async fn flush(
    st: &AppState,
    job: &Arc<tokio::sync::Mutex<WarmJob>>,
    batch: &mut Vec<WarmRow>,
    region_id: Option<&str>,
    final_state: &mut WarmState,
) -> bool {
    let now = now_secs();
    // The batched pinned write and its make-room eviction scan run on the blocking pool so the warm's
    // synchronous SQLite does not stall the async reactor.
    let cache = st.cache.clone();
    let rows = std::mem::take(batch);
    let budget = effective_budget(st, region_id);
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    let region_owned = region_id.map(str::to_string);
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
    use axum::http::header;
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
        // A real region's effective budget clamps to the cap, not to R - P.
        assert_eq!(
            effective_budget(&st, Some("r1")),
            1000,
            "R - P clamps to the cap"
        );
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
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-10.0, -10.0, 10.0, 10.0],
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
                    minzoom: 0,
                    maxzoom: 0,
                    region_id: None
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
                    minzoom: 0,
                    maxzoom: 12,
                    region_id: None
                }
            )
            .await,
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
            WarmRequest {
                sources: vec![src.clone()],
                bbox: [-180.0, -90.0, 180.0, 90.0],
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
    async fn warm_cancel_stops_between_tiles() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let job = start_warm(
            &st,
            WarmRequest {
                sources: vec![st.sources.read().await["s"].clone()],
                bbox: [-180.0, -85.0, 180.0, 85.0],
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
            attribution: String::new(),
        }
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
        assert!(
            st.cache
                .get(TileKey::new("style:basemap:openmaptiles", 0, 0, 0))
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
                minzoom: 14,
                maxzoom: 16,
                region_id: Some("r1".into()),
            },
        )
        .await
        .unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "done");
        assert!(
            st.cache
                .get(TileKey::new("style:basemap:openmaptiles", 15, 0, 0))
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
            .route("/sprites/{name}", get(|| async { ([(header::CONTENT_TYPE, "application/json")], r#"{"ok":1}"#) }));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    // The assets warm runs after the region job is marked Done, so wait_done returns before the assets
    // pin; poll the assets region until it holds bytes.
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
        let gk = crate::style::glyph_cache_source("basemap", "Noto Sans Regular");
        assert!(
            st.cache.get(TileKey::new(&gk, 0, 0, 0)).unwrap().is_some(),
            "a glyph range is pinned under the assets region"
        );
        let sk = crate::style::sprite_cache_source("basemap");
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
        let gk = crate::style::glyph_cache_source("basemap", "Noto Sans Regular");
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
