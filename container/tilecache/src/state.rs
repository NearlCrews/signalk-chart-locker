//! Shared service state: the cache, the egress HTTP client, the pushed source allowlist, the cache
//! and politeness knobs, the global egress semaphore, and the single-flight map.

use crate::cache::TileCache;
use crate::health::UpstreamHealth;
use crate::source::ChartSource;
use crate::ssrf::is_forbidden_ip;
use bytes::Bytes;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::ops::Deref;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, Notify, OwnedSemaphorePermit, RwLock, Semaphore};

/// Global concurrent egress fetches. Bounds the load the proxy puts on the upstream chart providers.
/// `pub(crate)` so the warm engine's fan-out limit can be checked against it (it must stay strictly below).
pub(crate) const EGRESS_CONCURRENCY: usize = 8;
/// Detached and awaited cache fills share this bound. Each fill may retain one distinct capped
/// upstream body while serialized SQLite work completes.
pub(crate) const MAX_FILL_TASKS: usize = 8;
pub(crate) const MAX_INFLIGHT_KEYS: usize = 256;
pub(crate) const MAX_TOUCH_TASKS: usize = 16;
pub(crate) const DEFAULT_MAX_BLOB_BYTES: usize = 8 * 1024 * 1024;
/// The container manager runs tilecache with a 512 MiB memory limit and no swap.
pub(crate) const MANAGED_MEMORY_LIMIT_BYTES: usize = 512 * 1024 * 1024;
/// JSON extractors reject larger control-plane bodies before deserializing them. Four MiB is hundreds
/// of times larger than the production catalog payload while keeping hostile uploads inexpensive.
pub(crate) const MAX_REQUEST_BODY_BYTES: usize = 4 * 1024 * 1024;
/// Hard bounds for concurrently executing HTTP handlers. Excess requests fail immediately instead of
/// queuing an unbounded number of SQLite blocking tasks. Health has its own small reserve so ordinary
/// traffic cannot consume every probe slot. The body-budget regression below conservatively counts
/// request and response bodies separately even though they share these slots. Six slots accommodate
/// the common browser same-origin connection limit without allowing a tile burst to grow unbounded.
pub(crate) const MAX_ACTIVE_REQUESTS: usize = 6;
pub(crate) const MAX_ACTIVE_HEALTH_REQUESTS: usize = 2;
/// Conservative ceiling for application-owned body buffers. Request and response bodies are counted
/// separately despite sharing request slots, and egress bodies are counted separately from fill and
/// warm tasks, so this does not depend on favorable task phasing.
pub(crate) const RETAINED_BODY_BUDGET_BYTES: usize = MAX_ACTIVE_REQUESTS * MAX_REQUEST_BODY_BYTES
    + MAX_ACTIVE_REQUESTS * DEFAULT_MAX_BLOB_BYTES
    + MAX_FILL_TASKS * DEFAULT_MAX_BLOB_BYTES
    + EGRESS_CONCURRENCY * DEFAULT_MAX_BLOB_BYTES
    + crate::warm::MAX_ACTIVE_WARM_JOBS * crate::warm::MAX_RETAINED_WARM_BATCH_BYTES
    + crate::warm::MAX_RETAINED_COMPLETED_WARM_RESULTS_BYTES;
const _: () = assert!(RETAINED_BODY_BUDGET_BYTES <= MANAGED_MEMORY_LIMIT_BYTES / 2);
const TILECACHE_USER_AGENT: &str =
    "signalk-chart-locker-tilecache/0.1.0 (+https://github.com/NearlCrews/signalk-chart-locker)";

/// The reserved pseudo-region id for position-warm pins. It is carved its own slice P of the regions
/// budget R (real regions gate against R - P), so position-warm neither escapes nor starves the
/// regions budget. It must match the plugin's POSITION_WARM_REGION_ID verbatim.
pub const POSITION_WARM_REGION_ID: &str = "__position_warm__";

/// The reserved pseudo-region id under which the global basemap assets (font glyphs and the sprite)
/// are pinned. Budgeted as a normal saved region (it gates against R - P, not the position-warm
/// reserve), and counted once toward the regions budget R through the existing EXISTS dedup.
pub const BASEMAP_ASSETS_REGION_ID: &str = "__basemap_assets__";

/// A DNS resolver that drops forbidden (private, loopback, link-local, multicast, unspecified) target
/// IPs when reqwest resolves a hostname. It closes the DNS-rebinding gap a pre-connect check leaves,
/// but reqwest does NOT consult it for a URL whose host is already a numeric IP literal, so a separate
/// literal-IP guard runs in `AppState::guarded_get` before every fetch.
struct GuardedResolver {
    allow_private: bool,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allow = self.allow_private;
        Box::pin(async move {
            let host = name.as_str().to_owned();
            let iter = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let addrs: Vec<SocketAddr> =
                iter.filter(|a| allow || !is_forbidden_ip(a.ip())).collect();
            let boxed: Addrs = Box::new(addrs.into_iter());
            Ok(boxed)
        })
    }
}

/// Tuning knobs, defaulted for a conservative microSD deployment.
#[derive(Debug, Clone)]
pub struct Knobs {
    pub cap_bytes: i64,
    pub max_blob_bytes: usize,
    pub negative_ttl_secs: i64,
    pub fresh_secs: i64,
    pub max_stale_secs: i64,
    /// Dev and test only: when true, the SSRF guard does not reject private or loopback targets, so a
    /// loopback stub upstream can be exercised. Production leaves this false.
    pub allow_private_egress: bool,
    /// The scroll-tile TTL in seconds, seeded from the env at construction so the startup sweep has a
    /// value before the plugin's first /config push. Zero disables the age sweep.
    pub scroll_ttl_secs: i64,
    /// The base (streak-zero) egress timeout in milliseconds. Both the client-level default timeout and
    /// the per-source adaptive schedule in `UpstreamHealth` derive from this, so the two cannot diverge.
    /// A compile-time default, set directly by tests: it is not exposed on POST /config and reads no env
    /// var, because the escalation is automatic and the issue asks for no user tuning surface.
    pub upstream_base_timeout_ms: u64,
}

impl Default for Knobs {
    fn default() -> Self {
        Self {
            cap_bytes: 2_147_483_648, // 2 GiB
            max_blob_bytes: DEFAULT_MAX_BLOB_BYTES,
            negative_ttl_secs: 600,
            fresh_secs: 86_400,
            max_stale_secs: 30 * 86_400,
            allow_private_egress: false,
            scroll_ttl_secs: 0,
            upstream_base_timeout_ms: 20_000,
        }
    }
}

/// Why an egress fetch failed, so the caller can adapt. A timeout escalates the per-source schedule and
/// is retried once; a transport error is treated as offline (serve stale) and is not retried. An SSRF
/// rejection and a closed egress semaphore both map to `Transport`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    Timeout,
    Transport,
}

/// An upstream response that retains the egress permit through body consumption.
#[derive(Debug)]
pub struct GuardedResponse {
    response: reqwest::Response,
    _permit: OwnedSemaphorePermit,
}

impl Deref for GuardedResponse {
    type Target = reqwest::Response;

    fn deref(&self) -> &Self::Target {
        &self.response
    }
}

/// Per-style upstream templates, learned when the style document is first fetched, so the glyph and
/// vector-tile sub-resource routes can reconstruct the upstream URL (the placeholders stay in the
/// outer URL, so the templates cannot be opaquely passed through).
#[derive(Clone)]
pub struct StyleState {
    pub glyphs: Option<String>,
    pub source_tiles: HashMap<String, Vec<String>>,
    pub source_maxzoom: HashMap<String, u32>,
    pub fontstacks: Vec<String>,
    pub sprite_base: Option<String>,
    pub generation: u64,
    /// Shared parsed document. Map entries and request handlers clone only this Arc, not the full JSON
    /// tree. The style document route makes one private copy when it must rewrite URLs for the client.
    pub document: Arc<serde_json::Value>,
    pub fetched_at: i64,
    pub upstream_validator: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub cache: Arc<TileCache>,
    pub client: reqwest::Client,
    pub sources: Arc<RwLock<HashMap<String, ChartSource>>>,
    /// The plugin-facing public base (for example /plugins/signalk-chart-locker), set by POST /config.
    pub public_base: Arc<RwLock<String>>,
    /// Per-style learned upstream templates, keyed by source id.
    pub style_state: Arc<RwLock<HashMap<String, Arc<StyleState>>>>,
    pub knobs: Knobs,
    pub egress: Arc<Semaphore>,
    pub inflight: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
    pub fill_semaphore: Arc<Semaphore>,
    pub fill_task_count: Arc<AtomicUsize>,
    pub fill_task_notify: Arc<Notify>,
    pub touch_semaphore: Arc<Semaphore>,
    pub request_semaphore: Arc<Semaphore>,
    pub health_request_semaphore: Arc<Semaphore>,
    /// In-memory warm-job registry, keyed by job id and reaped after a TTL once finished.
    pub warm_jobs: Arc<RwLock<HashMap<String, Arc<Mutex<crate::warm::WarmJob>>>>>,
    /// Logical region ids with a running warm. Prevents two jobs from clearing or promoting the same
    /// durable region concurrently, and lets deletion wait until cancellation has fully drained.
    pub active_warm_regions: Arc<Mutex<HashSet<String>>>,
    /// Bounds warm fan-out strictly below `EGRESS_CONCURRENCY` so a warm cannot starve live reads.
    pub warm_semaphore: Arc<Semaphore>,
    /// Monotonic source of warm job ids.
    pub warm_seq: Arc<AtomicU64>,
    pub boot_id: Arc<str>,
    pub warm_task_count: Arc<AtomicUsize>,
    pub warm_task_notify: Arc<Notify>,
    pub shutdown_requested: Arc<AtomicBool>,
    /// The live cache byte cap, initialized from `knobs.cap_bytes` and updated by POST /config so the
    /// owner can retune it without a container restart. The whole cap is the ceiling on the physical
    /// total; under the soft reserve the scroll cache uses the cap minus the bytes actually pinned.
    pub live_cap_bytes: Arc<AtomicI64>,
    /// R: the soft-reserve ceiling on total pinned (saved-region) bytes. A region warm evicts unpinned
    /// scroll tiles to make room and never pinned tiles, so R bounds the pinned set, not the scroll
    /// cache. Initialized to 0, set by POST /config.
    pub live_regions_budget: Arc<AtomicI64>,
    /// P: the position-warm reserve carved out of R. Initialized to 0, set by POST /config.
    pub live_position_warm_budget: Arc<AtomicI64>,
    /// The live scroll-tile TTL in seconds, seeded from `knobs.scroll_ttl_secs` and updated by the
    /// dedicated POST /cache/scroll-ttl route. Zero disables the age sweep.
    pub live_scroll_ttl_secs: Arc<AtomicI64>,
    /// True after the plugin has pushed the source allowlist and live budgets at least once.
    pub configured: Arc<AtomicBool>,
    pub config_generation: Arc<AtomicU64>,
    pub config_update: Arc<Mutex<()>>,
    pub control_token: Option<Arc<str>>,
    pub geocoding_enabled: Arc<AtomicBool>,
    pub(crate) geocode_state: Arc<Mutex<crate::geocode::GeocodeState>>,
    /// Operator-facing counters for rejected warm requests and accepted config pushes.
    pub warm_rejections: Arc<AtomicU64>,
    pub config_pushes: Arc<AtomicU64>,
    pub cache_operation_errors: Arc<AtomicU64>,
    /// Single-flight guard for the one-time global basemap assets warm, so two concurrent basemap
    /// downloads do not both fetch the full glyph and sprite set.
    pub assets_warming: Arc<AtomicBool>,
    /// Per-source upstream health: the adaptive egress timeout that backs off while a source keeps timing
    /// out. Read on every `fetch_upstream` and surfaced on /cache/stats.
    pub upstream_health: Arc<UpstreamHealth>,
}

impl AppState {
    pub fn new(cache: Arc<TileCache>, knobs: Knobs) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(TILECACHE_USER_AGENT)
            // The client default is the base timeout: `fetch_upstream` overrides it per request with the
            // adaptive schedule, so only the direct-fetch callers (style-document learn, geocode) run here.
            .timeout(Duration::from_millis(knobs.upstream_base_timeout_ms))
            .dns_resolver(Arc::new(GuardedResolver {
                allow_private: knobs.allow_private_egress,
            }))
            .build()
            .expect("the rustls HTTP client builds with the platform certificate verifier");
        // Captured before the struct literal moves `knobs` into its field.
        let cap_bytes = knobs.cap_bytes;
        let scroll_ttl_secs = knobs.scroll_ttl_secs;
        let base_timeout_ms = knobs.upstream_base_timeout_ms;
        Self {
            cache,
            client,
            sources: Arc::new(RwLock::new(HashMap::new())),
            public_base: Arc::new(RwLock::new(String::new())),
            style_state: Arc::new(RwLock::new(HashMap::new())),
            knobs,
            egress: Arc::new(Semaphore::new(EGRESS_CONCURRENCY)),
            inflight: Arc::new(Mutex::new(HashMap::new())),
            fill_semaphore: Arc::new(Semaphore::new(MAX_FILL_TASKS)),
            fill_task_count: Arc::new(AtomicUsize::new(0)),
            fill_task_notify: Arc::new(Notify::new()),
            touch_semaphore: Arc::new(Semaphore::new(MAX_TOUCH_TASKS)),
            request_semaphore: Arc::new(Semaphore::new(MAX_ACTIVE_REQUESTS)),
            health_request_semaphore: Arc::new(Semaphore::new(MAX_ACTIVE_HEALTH_REQUESTS)),
            warm_jobs: Arc::new(RwLock::new(HashMap::new())),
            active_warm_regions: Arc::new(Mutex::new(HashSet::new())),
            warm_semaphore: Arc::new(Semaphore::new(crate::warm::WARM_CONCURRENCY)),
            warm_seq: Arc::new(AtomicU64::new(0)),
            boot_id: Arc::from(uuid::Uuid::new_v4().simple().to_string()),
            warm_task_count: Arc::new(AtomicUsize::new(0)),
            warm_task_notify: Arc::new(Notify::new()),
            shutdown_requested: Arc::new(AtomicBool::new(false)),
            live_cap_bytes: Arc::new(AtomicI64::new(cap_bytes)),
            live_regions_budget: Arc::new(AtomicI64::new(0)),
            live_position_warm_budget: Arc::new(AtomicI64::new(0)),
            live_scroll_ttl_secs: Arc::new(AtomicI64::new(scroll_ttl_secs)),
            configured: Arc::new(AtomicBool::new(false)),
            config_generation: Arc::new(AtomicU64::new(0)),
            config_update: Arc::new(Mutex::new(())),
            control_token: std::env::var("TILECACHE_CONTROL_TOKEN")
                .ok()
                .filter(|value| !value.is_empty())
                .map(Arc::from),
            geocoding_enabled: Arc::new(AtomicBool::new(
                std::env::var("TILECACHE_GEOCODING_ENABLED").as_deref() != Ok("0"),
            )),
            geocode_state: Arc::new(Mutex::new(crate::geocode::GeocodeState::default())),
            warm_rejections: Arc::new(AtomicU64::new(0)),
            config_pushes: Arc::new(AtomicU64::new(0)),
            cache_operation_errors: Arc::new(AtomicU64::new(0)),
            assets_warming: Arc::new(AtomicBool::new(false)),
            upstream_health: Arc::new(UpstreamHealth::new(base_timeout_ms)),
        }
    }

    /// A GET that enforces egress safety: it rejects a URL whose host is a forbidden IP literal (the
    /// DNS resolver never sees a literal), then takes an egress permit and sends the request. `timeout`
    /// applies a per-request timeout that overrides the client-level default; `None` leaves the client
    /// default in place. Returns a `FetchError`: `Timeout` for a timed-out send, `Transport` for a
    /// rejected host, a permit failure, or any other send error.
    pub async fn guarded_get(
        &self,
        url: &str,
        if_none_match: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<GuardedResponse, FetchError> {
        match if_none_match {
            Some(v) if v.starts_with("last-modified:") => {
                self.guarded_get_with_headers(
                    url,
                    &[(
                        reqwest::header::IF_MODIFIED_SINCE,
                        v.trim_start_matches("last-modified:"),
                    )],
                    timeout,
                )
                .await
            }
            Some(v) => {
                self.guarded_get_with_headers(
                    url,
                    &[(
                        reqwest::header::IF_NONE_MATCH,
                        v.trim_start_matches("etag:"),
                    )],
                    timeout,
                )
                .await
            }
            None => self.guarded_get_with_headers(url, &[], timeout).await,
        }
    }

    /// The same guarded GET as `guarded_get`, with caller-supplied request headers (for example the
    /// contactable User-Agent the geocode proxy must send). Keeps the literal-IP guard, the egress
    /// permit, and the send in one place so every egress path shares the SSRF discipline.
    pub async fn guarded_get_with_headers(
        &self,
        url: &str,
        headers: &[(reqwest::header::HeaderName, &str)],
        timeout: Option<Duration>,
    ) -> Result<GuardedResponse, FetchError> {
        if !self.knobs.allow_private_egress && crate::ssrf::is_forbidden_ip_literal_url(url) {
            return Err(FetchError::Transport);
        }
        let permit = self
            .egress
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| FetchError::Transport)?;
        let mut req = self.client.get(url);
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        for (name, value) in headers {
            req = req.header(name.clone(), *value);
        }
        let response = req.send().await.map_err(|e| {
            if e.is_timeout() {
                FetchError::Timeout
            } else {
                FetchError::Transport
            }
        })?;
        Ok(GuardedResponse {
            response,
            _permit: permit,
        })
    }

    /// Read a response body with a hard cap, streaming chunks so a gzip or brotli decompression bomb or
    /// a chunked body with no Content-Length cannot be read unbounded into memory. Returns None when the
    /// body exceeds `max_blob_bytes` (the pre-read Content-Length check is None after decompression, so
    /// this is the real bound).
    pub async fn read_capped(&self, resp: GuardedResponse) -> Option<Bytes> {
        self.read_capped_to(resp, self.knobs.max_blob_bytes).await
    }

    pub async fn read_capped_to(
        &self,
        mut resp: GuardedResponse,
        max_bytes: usize,
    ) -> Option<Bytes> {
        // Pre-size from Content-Length when the upstream sent one, clamped to the cap so a lying length
        // cannot force a large up-front allocation. The streaming cap below is the real bound.
        let hint = resp.content_length().unwrap_or(0).min(max_bytes as u64) as usize;
        let mut buf: Vec<u8> = Vec::with_capacity(hint);
        while let Some(chunk) = resp.response.chunk().await.ok()? {
            if buf.len().checked_add(chunk.len())? > max_bytes {
                return None;
            }
            buf.extend_from_slice(&chunk);
        }
        Some(Bytes::from(buf))
    }

    /// Get (or create) the per-key single-flight lock, so duplicate concurrent misses coalesce.
    pub async fn inflight_lock(&self, key: &str) -> Option<Arc<Mutex<()>>> {
        let mut map = self.inflight.lock().await;
        if let Some(lock) = map.get(key).and_then(Weak::upgrade) {
            return Some(lock);
        }
        map.remove(key);
        // A canceled handler drops its only strong lease. Remove all such dead weak entries before
        // enforcing the key cap so unique canceled requests cannot exhaust admission until restart.
        map.retain(|_, lock| lock.strong_count() > 0);
        if map.len() >= MAX_INFLIGHT_KEYS {
            return None;
        }
        let lock = Arc::new(Mutex::new(()));
        map.insert(key.to_string(), Arc::downgrade(&lock));
        Some(lock)
    }

    /// Drop a live single-flight entry once this caller is its only holder. The map stores only a Weak,
    /// so cancellation is safe even when a caller never reaches this eager cleanup path.
    pub async fn inflight_finish(&self, key: &str, lock: &Arc<Mutex<()>>) {
        let mut map = self.inflight.lock().await;
        let is_current = map
            .get(key)
            .and_then(Weak::upgrade)
            .is_some_and(|current| Arc::ptr_eq(&current, lock));
        if is_current && Arc::strong_count(lock) == 1 {
            map.remove(key);
        }
    }

    /// True when a fill already holds or awaits the single-flight entry for this key, so the
    /// stale-while-revalidate path spawns at most one background fill per tile.
    pub async fn inflight_contains(&self, key: &str) -> bool {
        let mut map = self.inflight.lock().await;
        if map.get(key).and_then(Weak::upgrade).is_some() {
            true
        } else {
            map.remove(key);
            false
        }
    }

    pub fn try_fill_permit(&self) -> Option<OwnedSemaphorePermit> {
        if self
            .shutdown_requested
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return None;
        }
        self.fill_semaphore.clone().try_acquire_owned().ok()
    }

    pub fn try_touch_permit(&self) -> Option<OwnedSemaphorePermit> {
        self.touch_semaphore.clone().try_acquire_owned().ok()
    }

    /// Execute a synchronous SQLite lookup away from Tokio's reactor threads.
    pub async fn cache_get(
        &self,
        source: &str,
        z: u32,
        x: u32,
        y: u32,
    ) -> rusqlite::Result<Option<crate::cache::CachedTile>> {
        let cache = self.cache.clone();
        let source = source.to_string();
        tokio::task::spawn_blocking(move || cache.get(crate::cache::TileKey::new(&source, z, x, y)))
            .await
            .map_err(|_| rusqlite::Error::InvalidQuery)?
    }

    pub fn control_authorized(&self, supplied: Option<&str>) -> bool {
        let Some(expected) = self.control_token.as_deref() else {
            return false;
        };
        let supplied = supplied.unwrap_or_default().as_bytes();
        let expected = expected.as_bytes();
        let max_len = supplied.len().max(expected.len());
        let mut diff = supplied.len() ^ expected.len();
        for index in 0..max_len {
            diff |= supplied.get(index).copied().unwrap_or_default() as usize
                ^ expected.get(index).copied().unwrap_or_default() as usize;
        }
        diff == 0
    }
}

/// Seconds since the Unix epoch.
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{AppState, FetchError, GuardedResolver, Knobs};
    use crate::cache::TileCache;
    use axum::http::{header, HeaderMap};
    use axum::{routing::get, Router};
    use reqwest::dns::{Name, Resolve};
    use std::net::SocketAddr;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tempfile::NamedTempFile;
    use tokio::net::TcpListener;
    use tokio::sync::Semaphore;

    async fn serve(app: Router) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        address
    }

    #[test]
    fn retained_body_budget_leaves_half_the_container_for_runtime_work() {
        let request_bodies = super::MAX_ACTIVE_REQUESTS * super::MAX_REQUEST_BODY_BYTES;
        let response_bodies = super::MAX_ACTIVE_REQUESTS * super::DEFAULT_MAX_BLOB_BYTES;
        let fill_bodies = super::MAX_FILL_TASKS * super::DEFAULT_MAX_BLOB_BYTES;
        let egress_bodies = super::EGRESS_CONCURRENCY * super::DEFAULT_MAX_BLOB_BYTES;
        // A warm batch can sit just below its byte threshold before one maximum-size result is added.
        // Every active job can be waiting on the serialized SQLite writer with such a batch.
        let warm_batches =
            crate::warm::MAX_ACTIVE_WARM_JOBS * crate::warm::MAX_RETAINED_WARM_BATCH_BYTES;
        let completed_warm_results = crate::warm::MAX_RETAINED_COMPLETED_WARM_RESULTS_BYTES;
        let retained_body_ceiling = request_bodies
            + response_bodies
            + fill_bodies
            + egress_bodies
            + warm_batches
            + completed_warm_results;

        assert_eq!(request_bodies, 24 * 1024 * 1024);
        assert_eq!(response_bodies, 48 * 1024 * 1024);
        assert_eq!(fill_bodies, 64 * 1024 * 1024);
        assert_eq!(egress_bodies, 64 * 1024 * 1024);
        assert_eq!(warm_batches, 24 * 1024 * 1024);
        assert_eq!(completed_warm_results, 24 * 1024 * 1024);
        assert_eq!(retained_body_ceiling, 248 * 1024 * 1024);
        assert_eq!(retained_body_ceiling, super::RETAINED_BODY_BUDGET_BYTES);
        assert!(
            retained_body_ceiling <= super::MANAGED_MEMORY_LIMIT_BYTES / 2,
            "bounded bodies must leave at least half the managed limit for SQLite, allocator overhead, persistent style state, and the runtime",
        );
    }

    // The SSRF DNS-rebind guard must drop any looked-up address that lands in a forbidden range, so
    // an allowlisted hostname that resolves (or rebinds) to loopback or a private IP cannot turn the
    // read proxy into an SSRF pivot. `localhost` resolves only to loopback (127.0.0.1 or ::1).
    #[tokio::test]
    async fn guarded_resolver_drops_loopback_but_keeps_it_when_private_is_allowed() {
        let guarded = GuardedResolver {
            allow_private: false,
        };
        let filtered: Vec<SocketAddr> = guarded
            .resolve(Name::from_str("localhost").unwrap())
            .await
            .expect("the lookup itself succeeds; the guard filters its results")
            .collect();
        assert!(
            filtered.is_empty(),
            "loopback must be filtered out, got {filtered:?}"
        );

        // The dev/test escape hatch keeps the loopback address, proving the filter (not a failed
        // lookup) is what emptied the guarded result above.
        let unguarded = GuardedResolver {
            allow_private: true,
        };
        let kept: Vec<SocketAddr> = unguarded
            .resolve(Name::from_str("localhost").unwrap())
            .await
            .expect("the lookup succeeds")
            .collect();
        assert!(
            !kept.is_empty(),
            "allow_private must keep the loopback address"
        );
    }

    // End to end through the real shipped egress entry point: AppState::guarded_get carries both SSRF
    // layers (the literal-IP pre-check and the guarded DNS resolver). A host that resolves only to
    // loopback hands the connector zero addresses, so the guarded fetch fails as a Transport error, not
    // a Timeout. Driving guarded_get (not a hand-built client) proves the guard the container actually
    // ships rejects the loopback host.
    #[tokio::test]
    async fn a_client_using_the_guarded_resolver_rejects_a_loopback_host() {
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let state = AppState::new(
            cache,
            Knobs {
                allow_private_egress: false,
                ..Default::default()
            },
        );
        let err = state
            .guarded_get("http://localhost/", None, None)
            .await
            .expect_err("guarded_get must reject a loopback-resolving host");
        assert_eq!(
            err,
            FetchError::Transport,
            "a host resolving only to loopback yields zero addresses: a Transport failure, not a Timeout"
        );
    }

    #[tokio::test]
    async fn guarded_get_identifies_the_application_and_translates_a_last_modified_validator() {
        let seen = Arc::new(AtomicBool::new(false));
        let seen_by_server = seen.clone();
        let address = serve(Router::new().route(
            "/",
            get(move |headers: HeaderMap| {
                let seen = seen_by_server.clone();
                async move {
                    seen.store(
                        headers.get(header::IF_MODIFIED_SINCE)
                            == Some(&"Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap())
                            && headers
                                .get(header::USER_AGENT)
                                .and_then(|value| value.to_str().ok())
                                == Some(super::TILECACHE_USER_AGENT),
                        Ordering::Release,
                    );
                    "ok"
                }
            }),
        ))
        .await;
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let state = AppState::new(
            cache,
            Knobs {
                allow_private_egress: true,
                ..Default::default()
            },
        );
        let response = state
            .guarded_get(
                &format!("http://{address}/"),
                Some("last-modified:Wed, 21 Oct 2015 07:28:00 GMT"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(state.read_capped(response).await.unwrap(), "ok");
        assert!(seen.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn egress_permit_is_held_until_the_response_body_owner_drops() {
        let address = serve(Router::new().route("/", get(|| async { "ok" }))).await;
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let mut state = AppState::new(
            cache,
            Knobs {
                allow_private_egress: true,
                ..Default::default()
            },
        );
        state.egress = Arc::new(Semaphore::new(1));
        let url = format!("http://{address}/");
        let first = state.guarded_get(&url, None, None).await.unwrap();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                state.guarded_get(&url, None, None),
            )
            .await
            .is_err(),
            "a second request waits while the first response still owns the permit",
        );
        drop(first);
        let second = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            state.guarded_get(&url, None, None),
        )
        .await
        .expect("the permit is released when the response owner drops")
        .unwrap();
        assert_eq!(state.read_capped(second).await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn background_fill_touch_and_inflight_admission_are_bounded() {
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let state = AppState::new(cache, Knobs::default());

        let fills: Vec<_> = (0..super::MAX_FILL_TASKS)
            .map(|_| {
                state
                    .try_fill_permit()
                    .expect("fill permit within the bound")
            })
            .collect();
        assert!(state.try_fill_permit().is_none());
        drop(fills);

        let touches: Vec<_> = (0..super::MAX_TOUCH_TASKS)
            .map(|_| {
                state
                    .try_touch_permit()
                    .expect("touch permit within the bound")
            })
            .collect();
        assert!(state.try_touch_permit().is_none());
        drop(touches);

        let mut flights = Vec::new();
        for index in 0..super::MAX_INFLIGHT_KEYS {
            flights.push(
                state
                    .inflight_lock(&format!("key-{index}"))
                    .await
                    .expect("single-flight entry within the bound"),
            );
        }
        assert!(state.inflight_lock("one-too-many").await.is_none());
    }

    #[tokio::test]
    async fn aborted_single_flight_owner_cannot_exhaust_unique_key_admission() {
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let state = AppState::new(cache, Knobs::default());
        let task_state = state.clone();
        let task = tokio::spawn(async move {
            let flight = task_state.inflight_lock("aborted-handler").await.unwrap();
            let _guard = flight.lock().await;
            std::future::pending::<()>().await;
        });
        while !state.inflight_contains("aborted-handler").await {
            tokio::task::yield_now().await;
        }
        task.abort();
        let _ = task.await;
        assert!(
            !state.inflight_contains("aborted-handler").await,
            "dropping the canceled future makes its weak entry dead",
        );

        for index in 0..super::MAX_INFLIGHT_KEYS {
            let flight = state
                .inflight_lock(&format!("canceled-{index}"))
                .await
                .unwrap();
            drop(flight);
        }
        assert!(
            state.inflight_lock("later-live-request").await.is_some(),
            "dead unique entries are pruned before the admission cap is checked",
        );
    }
}
