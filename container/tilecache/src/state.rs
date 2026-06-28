//! Shared service state: the cache, the egress HTTP client, the pushed source allowlist, the cache
//! and politeness knobs, the global egress semaphore, and the single-flight map.

use crate::cache::TileCache;
use crate::source::ChartSource;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock, Semaphore};

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

#[derive(Clone)]
pub struct AppState {
    pub cache: Arc<TileCache>,
    pub client: reqwest::Client,
    pub sources: Arc<RwLock<HashMap<String, ChartSource>>>,
    /// The plugin-facing public base (for example /plugins/signalk-binnacle-companion), set by POST /config.
    pub public_base: Arc<RwLock<String>>,
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
            .build()
            .expect("the rustls HTTP client builds with static webpki roots");
        Self {
            cache,
            client,
            sources: Arc::new(RwLock::new(HashMap::new())),
            public_base: Arc::new(RwLock::new(String::new())),
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

    /// Drop a single-flight entry once no one else holds it, so the map does not grow without bound.
    pub async fn inflight_release(&self, key: &str, lock: Arc<Mutex<()>>) {
        let mut map = self.inflight.lock().await;
        // 2 = this `lock` plus the map entry; no other waiter holds a clone.
        if Arc::strong_count(&lock) <= 2 {
            map.remove(key);
        }
    }
}

/// Seconds since the Unix epoch.
pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
