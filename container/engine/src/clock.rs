//! Wall-clock access for the deadline checks, the `Date.now()` equivalent. With no
//! deadline set these are never read, so the engine stays a pure function of its inputs.
//! Shared by the grid build, A*, and the orchestrator so the deadline behavior lives in
//! one place.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        // A clock set before the epoch (duration_since errors) falls back to 0.0. With
        // now_ms() == 0.0 every `now_ms() > deadline` is false, so a broken clock
        // disables the deadline and the route is allowed to COMPLETE, the safe direction
        // (a declined route is the failure we avoid). No log here: a persistently broken
        // clock would otherwise spam every call.
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// True when a deadline is set and the wall clock has passed it.
pub(crate) fn over_deadline(deadline_ms: Option<f64>) -> bool {
    matches!(deadline_ms, Some(d) if now_ms() > d)
}
