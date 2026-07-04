//! The background scroll-tile TTL sweeper: an interval task whose immediate first tick is the startup
//! sweep, then a fixed period. It logs on error and never panics, so a transient SQLite error cannot
//! end the interval or wedge the TTL until the next container restart.

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
    let cache = state.cache.clone();
    match tokio::task::spawn_blocking(move || cache.sweep_aged_unpinned(ttl, now)).await {
        Ok(Ok((bytes, rows))) => {
            if rows > 0 {
                eprintln!("tilecache: scroll TTL swept {rows} tiles, {bytes} bytes");
            }
        }
        Ok(Err(e)) => eprintln!("tilecache: scroll TTL sweep failed: {e}"),
        Err(e) => eprintln!("tilecache: scroll TTL sweep task failed: {e}"),
    }
}

/// The interval loop. The first `tick()` returns immediately, so it is the startup sweep.
pub async fn run_sweeper(state: AppState) {
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
