//! The background scroll-tile TTL sweeper: an interval task whose immediate first tick is the startup
//! sweep, run once the first configuration push has landed, then a fixed period. It logs on error and
//! never panics, so a transient SQLite error cannot end the interval or wedge the TTL until the next
//! container restart.

use crate::state::{now_secs, AppState};
use std::sync::atomic::Ordering;
use std::time::Duration;

/// The sweep period. The TTL window is the user knob; this cadence is fixed. It stays well above the
/// last_access touch throttle (an hour), so the minimum useful TTL is one day.
const SWEEP_INTERVAL_SECS: u64 = 3600;

/// Run one sweep, off the async runtime thread, logging the outcome. Never panics.
pub async fn run_sweep_once(state: &AppState) {
    let ttl = state.live_scroll_ttl_secs.load(Ordering::Relaxed);
    let now = now_secs();
    if let Some((bytes, rows)) = state
        .cache_task("scroll_ttl_sweep", None, move |cache| {
            cache.sweep_aged_unpinned(ttl, now)
        })
        .await
    {
        if rows > 0 {
            eprintln!("event=scroll_ttl_swept rows={rows} bytes={bytes}");
        }
    }
}

/// The interval loop. The first `tick()` returns immediately, so it is the startup sweep. It waits for
/// the first accepted configuration push: the live TTL is authoritative only from then on, and a
/// process the runtime restarted outside the plugin lifecycle still carries the TTL its container was
/// created with, which can predate an operator's change.
pub async fn run_sweeper(state: AppState) {
    state.wait_until_configured().await;
    let mut ticker = tokio::time::interval(Duration::from_secs(SWEEP_INTERVAL_SECS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        run_sweep_once(&state).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::{CachedTile, TileCache, TileKey};
    use crate::state::Knobs;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    fn scroll_tile(bytes: i64, last_access: i64) -> CachedTile {
        CachedTile {
            content_type: "image/png".into(),
            strong_etag: "e".into(),
            upstream_validator: None,
            status: 200,
            fetched_at: 0,
            last_access,
            bytes,
            blob: Some(bytes::Bytes::from(vec![0u8; bytes as usize])),
        }
    }

    #[tokio::test]
    async fn run_sweep_once_evicts_aged_unpinned_when_ttl_is_set() {
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        cache
            .put(TileKey::new("s", 0, 0, 0), &scroll_tile(10, 0), false, 0)
            .unwrap();
        let knobs = Knobs {
            scroll_ttl_secs: 1,
            ..Default::default()
        };
        let state = AppState::new(cache.clone(), knobs);
        run_sweep_once(&state).await;
        assert!(
            cache.get(TileKey::new("s", 0, 0, 0)).unwrap().is_none(),
            "the aged unpinned tile is swept"
        );
    }

    // A process restarted outside the plugin lifecycle carries the TTL its container was created with,
    // and the operator may have lengthened or disabled it since. Nothing is swept until a configuration
    // push has made the live TTL authoritative.
    #[tokio::test]
    async fn the_startup_sweep_waits_for_the_first_configuration() {
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let key = TileKey::new("s", 0, 0, 0);
        cache.put(key, &scroll_tile(10, 0), false, 0).unwrap();
        let knobs = Knobs {
            scroll_ttl_secs: 1,
            ..Default::default()
        };
        let state = AppState::new(cache.clone(), knobs);
        let sweeper = tokio::spawn(run_sweeper(state.clone()));
        // Long enough for a startup sweep that did not wait to have deleted the aged tile.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            cache.get(key).unwrap().is_some(),
            "nothing is swept before the first configuration push"
        );

        state.mark_configured();
        for _ in 0..50 {
            if cache.get(key).unwrap().is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        sweeper.abort();
        assert!(
            cache.get(key).unwrap().is_none(),
            "the startup sweep runs once the configuration lands"
        );
    }

    #[tokio::test]
    async fn run_sweep_once_is_a_no_op_when_ttl_is_zero() {
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        cache
            .put(TileKey::new("s", 0, 0, 0), &scroll_tile(10, 0), false, 0)
            .unwrap();
        let state = AppState::new(cache.clone(), Knobs::default());
        run_sweep_once(&state).await;
        assert!(
            cache.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "ttl 0 leaves the tile in place"
        );
    }
}
