//! Shared service state: the cache, the egress HTTP client, the pushed source allowlist, the cache
//! and politeness knobs, the global egress semaphore, and the single-flight map.

use crate::cache::TileCache;
use crate::source::ChartSource;
use crate::ssrf::is_forbidden_ip;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock, Semaphore};

/// A DNS resolver that drops forbidden (private, loopback, link-local, multicast, unspecified) target
/// IPs. Installed on the egress client so the SSRF check runs at the resolution reqwest actually
/// connects to, closing the rebinding and time-of-check-to-time-of-use gap a pre-connect check leaves.
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
}

#[derive(Clone)]
pub struct AppState {
    pub cache: Arc<TileCache>,
    pub client: reqwest::Client,
    pub sources: Arc<RwLock<HashMap<String, ChartSource>>>,
    /// The plugin-facing public base (for example /plugins/signalk-binnacle-companion), set by POST /config.
    pub public_base: Arc<RwLock<String>>,
    /// Per-style learned upstream templates, keyed by source id.
    pub style_state: Arc<RwLock<HashMap<String, StyleState>>>,
    pub knobs: Knobs,
    pub egress: Arc<Semaphore>,
    pub inflight: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl AppState {
    pub fn new(cache: Arc<TileCache>, knobs: Knobs) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("signalk-binnacle-companion-tilecache")
            .timeout(std::time::Duration::from_secs(20))
            .dns_resolver(Arc::new(GuardedResolver { allow_private: knobs.allow_private_egress }))
            .build()
            .expect("the rustls HTTP client builds with static webpki roots");
        Self {
            cache,
            client,
            sources: Arc::new(RwLock::new(HashMap::new())),
            public_base: Arc::new(RwLock::new(String::new())),
            style_state: Arc::new(RwLock::new(HashMap::new())),
            knobs,
            egress: Arc::new(Semaphore::new(8)),
            inflight: Arc::new(Mutex::new(HashMap::new())),
        }
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
