//! Per-source upstream health: an adaptive egress timeout that backs off while a source keeps timing
//! out and recovers after a quiet window. `fetcher::fetch_upstream` consults it before every fetch and
//! the stats route surfaces it under `upstream`. It exists because a degraded WMS upstream (observed at
//! about 65 seconds per tile) times out every uncached fetch at a fixed client timeout, so the schedule
//! escalates the timeout for that source alone rather than raising it globally.

use std::collections::HashMap;
use std::sync::Mutex;

/// The hard ceiling on the adaptive timeout, regardless of the base or the streak.
const MAX_TIMEOUT_MS: u64 = 90_000;
/// The streak caps here, so the schedule tops out at `base << STREAK_CAP` (base, base*2, base*4).
const STREAK_CAP: u32 = 2;
/// A recorded success this many quiet seconds after the last timeout clears the source's escalation.
const RECOVERY_SECS: i64 = 300;

/// One source's escalation state.
struct SourceHealth {
    streak: u32,
    last_timeout_at: i64,
}

/// A per-source health row for the stats route. Plain data so the route owns the wire shape.
pub struct HealthSnapshot {
    pub source: String,
    pub streak: u32,
    pub timeout_ms: u64,
    pub last_timeout_at: i64,
}

/// Tracks a per-source egress timeout that escalates on repeated timeouts and recovers after a quiet
/// window. Callers pass `now` (the codebase clock idiom, so unit tests stay clock-free). Every method
/// locks the inner map and drops the guard before returning, and none is async, so the guard is never
/// held across an await.
pub struct UpstreamHealth {
    base_ms: u64,
    inner: Mutex<HashMap<String, SourceHealth>>,
}

impl UpstreamHealth {
    pub fn new(base_ms: u64) -> Self {
        Self {
            base_ms,
            inner: Mutex::new(HashMap::new()),
        }
    }

    // The critical sections are infallible map and arithmetic operations, so the mutex is never poisoned;
    // recover the guard on a theoretical poison rather than cascade a panic.
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, SourceHealth>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    // The schedule for a given streak: `base << streak`, clamped to the ceiling. Shared by `timeout_ms`
    // and `snapshot` so the two cannot diverge.
    fn schedule(&self, streak: u32) -> u64 {
        (self.base_ms << streak).min(MAX_TIMEOUT_MS)
    }

    /// The current timeout for a source. An unknown source runs at the base.
    pub fn timeout_ms(&self, id: &str) -> u64 {
        let streak = self.map().get(id).map(|h| h.streak).unwrap_or(0);
        self.schedule(streak)
    }

    /// Record a timed-out fetch: bump the streak (capped) and stamp the time.
    pub fn record_timeout(&self, id: &str, now: i64) {
        let mut map = self.map();
        let entry = map.entry(id.to_string()).or_insert(SourceHealth {
            streak: 0,
            last_timeout_at: now,
        });
        entry.streak = (entry.streak + 1).min(STREAK_CAP);
        entry.last_timeout_at = now;
    }

    /// Record a completed HTTP response (any status, so a fast 404 counts as responsive). After
    /// `RECOVERY_SECS` of quiet the entry is dropped (full recovery); within the window the escalation
    /// stays sticky, so a source that genuinely needs a long timeout does not oscillate back to the base
    /// after each success.
    pub fn record_success(&self, id: &str, now: i64) {
        let mut map = self.map();
        if let Some(h) = map.get(id) {
            if now - h.last_timeout_at >= RECOVERY_SECS {
                map.remove(id);
            }
        }
    }

    /// True when the source has a live escalation (streak greater than zero).
    pub fn is_slow(&self, id: &str) -> bool {
        self.map().get(id).map(|h| h.streak > 0).unwrap_or(false)
    }

    /// A snapshot of every source with a live health entry, for the stats route.
    pub fn snapshot(&self) -> Vec<HealthSnapshot> {
        self.map()
            .iter()
            .map(|(source, h)| HealthSnapshot {
                source: source.clone(),
                streak: h.streak,
                timeout_ms: self.schedule(h.streak),
                last_timeout_at: h.last_timeout_at,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_escalates_then_caps_at_the_streak_and_the_ceiling() {
        let h = UpstreamHealth::new(20_000);
        assert_eq!(h.timeout_ms("s"), 20_000, "an unknown source runs at the base");
        h.record_timeout("s", 0);
        assert_eq!(h.timeout_ms("s"), 40_000, "base * 2 after one timeout");
        h.record_timeout("s", 1);
        assert_eq!(h.timeout_ms("s"), 80_000, "base * 4 after two timeouts");
        // A third timeout does not push the streak past the cap, so the schedule holds at base * 4.
        h.record_timeout("s", 2);
        assert_eq!(h.timeout_ms("s"), 80_000, "the streak caps at 2");
        assert!(h.is_slow("s"));
        // A large base clamps at the 90 second ceiling: 60s << 1 is 120s, capped to 90s.
        let big = UpstreamHealth::new(60_000);
        big.record_timeout("s", 0);
        assert_eq!(big.timeout_ms("s"), 90_000, "base << streak clamps to the ceiling");
    }

    #[test]
    fn a_success_within_the_quiet_window_keeps_the_escalated_timeout() {
        let h = UpstreamHealth::new(20_000);
        h.record_timeout("s", 100);
        assert_eq!(h.timeout_ms("s"), 40_000);
        // 299 seconds later is still inside the 300 second window, so the escalation stays sticky.
        h.record_success("s", 100 + 299);
        assert_eq!(
            h.timeout_ms("s"),
            40_000,
            "the escalated timeout is sticky within the quiet window"
        );
        assert!(h.is_slow("s"));
    }

    #[test]
    fn a_success_after_the_quiet_window_resets_the_source() {
        let h = UpstreamHealth::new(20_000);
        h.record_timeout("s", 100);
        assert!(h.is_slow("s"));
        // Exactly 300 quiet seconds later: full recovery drops the entry and returns to the base.
        h.record_success("s", 100 + 300);
        assert_eq!(h.timeout_ms("s"), 20_000, "recovery returns the source to the base timeout");
        assert!(!h.is_slow("s"));
    }

    #[test]
    fn snapshot_reports_only_live_entries() {
        let h = UpstreamHealth::new(20_000);
        assert!(h.snapshot().is_empty(), "no entry means no snapshot row");
        h.record_timeout("depth-noaa", 1_751_690_000);
        let snap = h.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].source, "depth-noaa");
        assert_eq!(snap[0].streak, 1);
        assert_eq!(snap[0].timeout_ms, 40_000);
        assert_eq!(snap[0].last_timeout_at, 1_751_690_000);
    }
}
