//! The channel router orchestrator, ported from `channel-router.ts`: validate and
//! size the bbox, gather provider data, build the grid, snap the endpoints, run A*,
//! simplify, re-validate every leg at polygon resolution, and return the waypoints
//! or a typed decline. The snap ring order, the largest-component tie-break, and the
//! `used_tile_water` and `border_fallback` flag semantics must match the reference.

use crate::types::{ChannelRouteRequest, ChannelRouteResult, Provider, ScaleBand};

/// Compute a water-following route. With no deadline this is a pure function of the
/// request and the provider responses, which is what makes the replay corpus an
/// exact parity oracle.
pub fn route_channel(
    provider: &dyn Provider,
    bands: &[ScaleBand],
    req: &ChannelRouteRequest,
) -> ChannelRouteResult {
    todo!("port routeChannel from channel-router.ts")
}
