//! Non-finite coordinate hardening: a NaN or Inf in any request coordinate must
//! return Decline { reason: NoCoverage }, not panic, so the engine never reaches
//! route_bbox or position_to_bbox with a bad value.
//!
//! All tests use a NullProvider that returns None for every call; the finiteness
//! guard fires before any provider call, so the provider is irrelevant here.

use binnacle_engine::types::{Bbox, ChartedAreas, RingPolygon, TileWater};
use binnacle_engine::{
    route_channel, ChannelDeclineReason, ChannelRouteRequest, ChannelRouteResult, Position,
    Provider, ScaleBand,
};

struct NullProvider;

impl Provider for NullProvider {
    fn charted_areas(&self, _band: ScaleBand, _bbox: Bbox) -> Option<ChartedAreas> {
        None
    }
    fn tile_water(&self, _bbox: Bbox) -> Option<TileWater> {
        None
    }
    fn foreign_rings(&self, _bbox: Bbox) -> Vec<RingPolygon> {
        Vec::new()
    }
}

/// A valid finite request to use as a base for mutation tests.
fn finite_req() -> ChannelRouteRequest {
    ChannelRouteRequest {
        from: Position {
            latitude: 47.6,
            longitude: -122.4,
        },
        to: Position {
            latitude: 47.65,
            longitude: -122.3,
        },
        draft_meters: 1.5,
        safety_margin_meters: 0.5,
        standoff_nm: 0.0,
        corridor: None,
        bbox_anchors: None,
        border_aware: false,
        max_snap_meters: None,
        deadline_ms: None,
        home_country_id: None,
    }
}

fn is_no_coverage(r: &ChannelRouteResult) -> bool {
    matches!(
        r,
        ChannelRouteResult::Decline {
            reason: ChannelDeclineReason::NoCoverage,
        }
    )
}

/// NaN latitude in `from` must return Decline(NoCoverage), not panic.
#[test]
fn nan_latitude_in_from_returns_decline_no_coverage() {
    let mut req = finite_req();
    req.from.latitude = f64::NAN;
    let result = route_channel(&NullProvider, &[ScaleBand::Coastal], &req);
    assert!(is_no_coverage(&result), "expected NoCoverage, got {result:?}");
}

/// Inf longitude in `from` must return Decline(NoCoverage), not panic.
#[test]
fn inf_longitude_in_from_returns_decline_no_coverage() {
    let mut req = finite_req();
    req.from.longitude = f64::INFINITY;
    let result = route_channel(&NullProvider, &[ScaleBand::Coastal], &req);
    assert!(is_no_coverage(&result), "expected NoCoverage, got {result:?}");
}

/// NaN latitude in `to` must return Decline(NoCoverage), not panic.
#[test]
fn nan_latitude_in_to_returns_decline_no_coverage() {
    let mut req = finite_req();
    req.to.latitude = f64::NAN;
    let result = route_channel(&NullProvider, &[ScaleBand::Coastal], &req);
    assert!(is_no_coverage(&result), "expected NoCoverage, got {result:?}");
}

/// Neg-Inf longitude in `to` must return Decline(NoCoverage), not panic.
#[test]
fn neg_inf_longitude_in_to_returns_decline_no_coverage() {
    let mut req = finite_req();
    req.to.longitude = f64::NEG_INFINITY;
    let result = route_channel(&NullProvider, &[ScaleBand::Coastal], &req);
    assert!(is_no_coverage(&result), "expected NoCoverage, got {result:?}");
}

/// NaN in a bbox_anchor must return Decline(NoCoverage), not panic.
#[test]
fn nan_in_bbox_anchor_returns_decline_no_coverage() {
    let mut req = finite_req();
    req.bbox_anchors = Some(vec![
        Position {
            latitude: f64::NAN,
            longitude: -122.4,
        },
        Position {
            latitude: 47.65,
            longitude: -122.3,
        },
    ]);
    let result = route_channel(&NullProvider, &[ScaleBand::Coastal], &req);
    assert!(is_no_coverage(&result), "expected NoCoverage, got {result:?}");
}

/// NaN in a corridor position must return Decline(NoCoverage), not panic.
#[test]
fn nan_in_corridor_returns_decline_no_coverage() {
    let mut req = finite_req();
    req.corridor = Some(vec![
        Position {
            latitude: 47.6,
            longitude: -122.4,
        },
        Position {
            latitude: f64::NAN,
            longitude: -122.35,
        },
        Position {
            latitude: 47.65,
            longitude: -122.3,
        },
    ]);
    let result = route_channel(&NullProvider, &[ScaleBand::Coastal], &req);
    assert!(is_no_coverage(&result), "expected NoCoverage, got {result:?}");
}
