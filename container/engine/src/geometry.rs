//! Planar and spherical geometry primitives, ported from the crows-nest
//! `leg-geometry.ts` and the `position-utilities.ts` subset the router uses. All
//! work in degree space except `distance_meters`, which is spherical haversine.
//! Stubs pending the Milestone 2 port; see the plan's geometry contract.

use crate::types::{Bbox, Position, Rings};

/// Earth radius used by the haversine distance, meters.
pub const EARTH_RADIUS_METERS: f64 = 6_371_000.0;
/// Meters per degree of latitude, and of longitude at the equator.
pub const METERS_PER_DEGREE: f64 = 111_320.0;

/// Great-circle distance between two positions, haversine on a sphere of
/// `EARTH_RADIUS_METERS`.
pub fn distance_meters(a: Position, b: Position) -> f64 {
    todo!("port distanceMeters from position-utilities.ts")
}

/// Meters per degree of longitude at the given latitude: `111320 * cos(lat)`.
pub fn meters_per_degree_lon(latitude: f64) -> f64 {
    todo!("port metersPerDegreeLon from length.ts")
}

/// Axis-aligned bounds of all vertices across the rings.
pub fn bounds_of_rings(rings: &Rings) -> Bbox {
    todo!("port boundsOfRings from position-utilities.ts")
}

/// Even-odd ray cast in degree space, strict comparisons, no epsilon. Outer ring
/// and holes are handled by the even-odd rule across all rings.
pub fn point_in_rings(lon: f64, lat: f64, rings: &Rings) -> bool {
    todo!("port pointInRings from leg-geometry.ts")
}

/// Signed area of the triangle a, b, c: `(b-a) x (c-a)`.
pub fn orient2d(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    todo!("port orient2D from leg-geometry.ts")
}

/// Proper segment crossing only, strict inequalities, collinear excluded.
pub fn segments_cross(p1: [f64; 2], p2: [f64; 2], p3: [f64; 2], p4: [f64; 2]) -> bool {
    todo!("port segmentsCross from leg-geometry.ts")
}

/// True when segment a, b properly crosses any edge of any ring.
pub fn segment_crosses_rings(a: [f64; 2], b: [f64; 2], rings: &Rings) -> bool {
    todo!("port segmentCrossesRings from leg-geometry.ts")
}

/// Strictly interior sample points of a rhumb (constant-bearing) line, spaced
/// `spacing_meters` apart. Empty when the leg is shorter than one spacing.
pub fn sample_rhumb_leg(from: Position, to: Position, spacing_meters: f64) -> Vec<Position> {
    todo!("port sampleRhumbLeg from position-utilities.ts")
}

/// Union of each waypoint's bbox padded by `half_width_meters`.
pub fn route_bbox(waypoints: &[Position], half_width_meters: f64) -> Bbox {
    todo!("port routeBbox from leg-geometry.ts")
}
