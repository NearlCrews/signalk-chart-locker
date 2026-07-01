//! Shared service state: the cache, the egress HTTP client, the pushed source allowlist, the cache
//! and politeness knobs, the global egress semaphore, and the single-flight map.

use crate::cache::TileCache;
use crate::source::ChartSource;
use crate::ssrf::is_forbidden_ip;
use bytes::Bytes;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock, Semaphore};

/// Global concurrent egress fetches. Bounds the load the proxy puts on the upstream chart providers.
/// `pub(crate)` so the warm engine's fan-out limit can be checked against it (it must stay strictly below).
pub(crate) const EGRESS_CONCURRENCY: usize = 8;

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
            let addrs: Vec<SocketAddr> = iter.filter(|a| allow || !is_forbidden_ip(a.ip())).collect();
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
}

impl Default for Knobs {
    fn default() -> Self {
        Self {
            cap_bytes: 2_147_483_648, // 2 GiB
            max_blob_bytes: 8 * 1024 * 1024,
            negative_ttl_secs: 600,
            fresh_secs: 86_400,
            max_stale_secs: 30 * 86_400,
            allow_private_egress: false,
            scroll_ttl_secs: 0,
        }
    }
}

/// Per-style upstream templates, learned when the style document is first fetched, so the glyph and
/// vector-tile sub-resource routes can reconstruct the upstream URL (the placeholders stay in the
/// outer URL, so the templates cannot be opaquely passed through).
#[derive(Clone, Default)]
pub struct StyleState {
    pub glyphs: Option<String>,
    pub source_tiles: HashMap<String, Vec<String>>,
    pub source_maxzoom: HashMap<String, u32>,
    pub fontstacks: Vec<String>,
    pub sprite_base: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub cache: Arc<TileCache>,
    pub client: reqwest::Client,
    pub sources: Arc<RwLock<HashMap<String, ChartSource>>>,
    /// The plugin-facing public base (for example /plugins/signalk-chart-locker), set by POST /config.
    pub public_base: Arc<RwLock<String>>,
    /// Per-style learned upstream templates, keyed by source id.
    pub style_state: Arc<RwLock<HashMap<String, StyleState>>>,
    pub knobs: Knobs,
    pub egress: Arc<Semaphore>,
    pub inflight: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// In-memory warm-job registry, keyed by job id and reaped after a TTL once finished.
    pub warm_jobs: Arc<RwLock<HashMap<String, Arc<Mutex<crate::warm::WarmJob>>>>>,
    /// Bounds warm fan-out strictly below `EGRESS_CONCURRENCY` so a warm cannot starve live reads.
    pub warm_semaphore: Arc<Semaphore>,
    /// Monotonic source of warm job ids.
    pub warm_seq: Arc<AtomicU64>,
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
    /// Single-flight guard for the one-time global basemap assets warm, so two concurrent basemap
    /// downloads do not both fetch the full glyph and sprite set.
    pub assets_warming: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(cache: Arc<TileCache>, knobs: Knobs) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("signalk-chart-locker-tilecache")
            .timeout(std::time::Duration::from_secs(20))
            .dns_resolver(Arc::new(GuardedResolver { allow_private: knobs.allow_private_egress }))
            .build()
            .expect("the rustls HTTP client builds with static webpki roots");
        // Captured before the struct literal moves `knobs` into its field.
        let cap_bytes = knobs.cap_bytes;
        let scroll_ttl_secs = knobs.scroll_ttl_secs;
        Self {
            cache,
            client,
            sources: Arc::new(RwLock::new(HashMap::new())),
            public_base: Arc::new(RwLock::new(String::new())),
            style_state: Arc::new(RwLock::new(HashMap::new())),
            knobs,
            egress: Arc::new(Semaphore::new(EGRESS_CONCURRENCY)),
            inflight: Arc::new(Mutex::new(HashMap::new())),
            warm_jobs: Arc::new(RwLock::new(HashMap::new())),
            warm_semaphore: Arc::new(Semaphore::new(crate::warm::WARM_CONCURRENCY)),
            warm_seq: Arc::new(AtomicU64::new(0)),
            live_cap_bytes: Arc::new(AtomicI64::new(cap_bytes)),
            live_regions_budget: Arc::new(AtomicI64::new(0)),
            live_position_warm_budget: Arc::new(AtomicI64::new(0)),
            live_scroll_ttl_secs: Arc::new(AtomicI64::new(scroll_ttl_secs)),
            assets_warming: Arc::new(AtomicBool::new(false)),
        }
    }

    /// A GET that enforces egress safety: it rejects a URL whose host is a forbidden IP literal (the
    /// DNS resolver never sees a literal), then takes an egress permit and sends the request. Returns
    /// Err on a rejected host, a permit failure, or a transport error.
    pub async fn guarded_get(&self, url: &str, if_none_match: Option<&str>) -> Result<reqwest::Response, ()> {
        if !self.knobs.allow_private_egress && crate::ssrf::is_forbidden_ip_literal_url(url) {
            return Err(());
        }
        let _permit = self.egress.acquire().await.map_err(|_| ())?;
        let mut req = self.client.get(url);
        if let Some(v) = if_none_match {
            req = req.header(reqwest::header::IF_NONE_MATCH, v);
        }
        req.send().await.map_err(|_| ())
    }

    /// Read a response body with a hard cap, streaming chunks so a gzip or brotli decompression bomb or
    /// a chunked body with no Content-Length cannot be read unbounded into memory. Returns None when the
    /// body exceeds `max_blob_bytes` (the pre-read Content-Length check is None after decompression, so
    /// this is the real bound).
    pub async fn read_capped(&self, mut resp: reqwest::Response) -> Option<Bytes> {
        // Pre-size from Content-Length when the upstream sent one, clamped to the cap so a lying length
        // cannot force a large up-front allocation. The streaming cap below is the real bound.
        let hint = resp.content_length().unwrap_or(0).min(self.knobs.max_blob_bytes as u64) as usize;
        let mut buf: Vec<u8> = Vec::with_capacity(hint);
        while let Some(chunk) = resp.chunk().await.ok()? {
            if buf.len() + chunk.len() > self.knobs.max_blob_bytes {
                return None;
            }
            buf.extend_from_slice(&chunk);
        }
        Some(Bytes::from(buf))
    }

    /// Get (or create) the per-key single-flight lock, so duplicate concurrent misses coalesce.
    pub async fn inflight_lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut map = self.inflight.lock().await;
        map.entry(key.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    }

    /// Drop a single-flight entry once this caller is its only holder, so the map does not grow
    /// without bound (each waiter holds its own clone, so a strong count of 2 means map plus this
    /// caller and no other waiter). Takes the Arc by reference so it adds no transient clone.
    pub async fn inflight_finish(&self, key: &str, lock: &Arc<Mutex<()>>) {
        let mut map = self.inflight.lock().await;
        if Arc::strong_count(lock) <= 2 {
            map.remove(key);
        }
    }
}

/// Seconds since the Unix epoch.
pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
