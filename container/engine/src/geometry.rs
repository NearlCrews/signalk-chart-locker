//! Planar and spherical geometry primitives, ported from the crows-nest
//! `leg-geometry.ts` and the `position-utilities.ts` and `length.ts` subset the
//! router uses. The ring helpers work in degree space (longitude is x, latitude
//! is y), matching the GeoJSON `[lon, lat]` ring shape the providers emit.
//! `distance_meters` is spherical haversine; `sample_rhumb_leg` and `route_bbox`
//! walk the loxodrome and the great-circle projection respectively.
//!
//! The floating-point operation order mirrors the TypeScript exactly so a replay
//! corpus reproduces bit-for-bit. Where the TypeScript squares a value with `** 2`
//! this port uses `f64::powi(2)`, which evaluates to `x * x`; that equals
//! `Math.pow(x, 2)` for every finite `x`. `distance_meters`, `sample_rhumb_leg`,
//! and `route_bbox` rely on `f64::sin`, `cos`, `tan`, `atan2`, `asin`, `ln`, and
//! `hypot` matching the JavaScript `Math` transcendentals; these are platform libm
//! calls and are not guaranteed correctly rounded, so a residual ulp-level
//! difference on a given platform would surface here.

use crate::types::{Bbox, Position, Rings};

/// Earth radius used by the haversine distance and the rhumb sampler, meters.
pub const EARTH_RADIUS_METERS: f64 = 6_371_000.0;
/// Earth radius in kilometers, used by the great-circle projection in `route_bbox`.
const EARTH_RADIUS_KM: f64 = 6371.0;
/// Meters per degree of latitude, and of longitude at the equator.
pub const METERS_PER_DEGREE: f64 = 111_320.0;
/// Meters in one international nautical mile, exact by definition.
pub(crate) const METERS_PER_NAUTICAL_MILE: f64 = 1852.0;

/// Compass bearing from a center toward its north-west corner, degrees.
const NW_BEARING_DEGREES: f64 = -45.0;
/// Compass bearing from a center toward its south-east corner, degrees.
const SE_BEARING_DEGREES: f64 = 135.0;

/// Below this isometric-latitude change a leg is treated as east-west, falling
/// back to the parallel's `cos(latitude)` scale to avoid a 0/0.
const EAST_WEST_ISOMETRIC_EPSILON: f64 = 1e-12;

fn to_radians(degrees: f64) -> f64 {
    (degrees * std::f64::consts::PI) / 180.0
}

fn to_degrees(radians: f64) -> f64 {
    (radians * 180.0) / std::f64::consts::PI
}

/// Wrap a longitude in degrees into the canonical `[-180, 180)` range.
fn normalize_longitude(longitude: f64) -> f64 {
    ((longitude + 540.0) % 360.0) - 180.0
}

/// Wrap an east-west delta, in radians, to the shortest signed path.
fn wrap_delta_longitude_rad(delta_longitude: f64) -> f64 {
    if delta_longitude.abs() > std::f64::consts::PI {
        if delta_longitude > 0.0 {
            delta_longitude - 2.0 * std::f64::consts::PI
        } else {
            delta_longitude + 2.0 * std::f64::consts::PI
        }
    } else {
        delta_longitude
    }
}

/// Isometric (Mercator-stretched) latitude `ln(tan(pi/4 + lat/2))` in radians.
fn isometric_latitude_rad(latitude_rad: f64) -> f64 {
    (std::f64::consts::PI / 4.0 + latitude_rad / 2.0).tan().ln()
}

/// Great-circle distance between two positions, haversine on a sphere of
/// `EARTH_RADIUS_METERS`.
pub fn distance_meters(a: Position, b: Position) -> f64 {
    let latitude_a = to_radians(a.latitude);
    let latitude_b = to_radians(b.latitude);
    let delta_latitude = to_radians(b.latitude - a.latitude);
    let delta_longitude = to_radians(b.longitude - a.longitude);

    let haversine = (delta_latitude / 2.0).sin().powi(2)
        + latitude_a.cos() * latitude_b.cos() * (delta_longitude / 2.0).sin().powi(2);
    let angular_distance =
        2.0 * haversine.sqrt().atan2((1.0 - haversine).max(0.0).sqrt());

    EARTH_RADIUS_METERS * angular_distance
}

/// Meters per degree of longitude at the given latitude: `111320 * cos(lat)`.
pub fn meters_per_degree_lon(latitude: f64) -> f64 {
    METERS_PER_DEGREE * ((latitude * std::f64::consts::PI) / 180.0).cos()
}

/// Axis-aligned bounds of all vertices across the rings.
pub fn bounds_of_rings(rings: &Rings) -> Bbox {
    let mut north = f64::NEG_INFINITY;
    let mut south = f64::INFINITY;
    let mut east = f64::NEG_INFINITY;
    let mut west = f64::INFINITY;
    for ring in rings {
        for vertex in ring {
            let lon = vertex[0];
            let lat = vertex[1];
            if lat > north {
                north = lat;
            }
            if lat < south {
                south = lat;
            }
            if lon > east {
                east = lon;
            }
            if lon < west {
                west = lon;
            }
        }
    }
    Bbox {
        north,
        south,
        east,
        west,
    }
}

/// Even-odd ray cast in degree space, strict comparisons, no epsilon. The outer
/// ring and holes are handled by the even-odd rule across all rings, so a point
/// in a hole's interior counts as outside the polygon.
pub fn point_in_rings(lon: f64, lat: f64, rings: &Rings) -> bool {
    let mut inside = false;
    for ring in rings {
        let len = ring.len();
        if len == 0 {
            continue;
        }
        let mut j = len - 1;
        for i in 0..len {
            let xi = ring[i][0];
            let yi = ring[i][1];
            let xj = ring[j][0];
            let yj = ring[j][1];
            let intersects = ((yi > lat) != (yj > lat))
                && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi;
            if intersects {
                inside = !inside;
            }
            j = i;
        }
    }
    inside
}

/// Signed area of the triangle a, b, c (the 2D cross product); its sign gives the
/// turn direction.
pub fn orient2d(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// True when the two planar segments `p1->p2` and `p3->p4` properly cross. Strict
/// inequalities, so a shared endpoint or a collinear overlap does not count.
pub fn segments_cross(p1: [f64; 2], p2: [f64; 2], p3: [f64; 2], p4: [f64; 2]) -> bool {
    let d1 = orient2d(p3, p4, p1);
    let d2 = orient2d(p3, p4, p2);
    if !((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) {
        return false;
    }
    let d3 = orient2d(p1, p2, p3);
    let d4 = orient2d(p1, p2, p4);
    (d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0)
}

/// True when segment a, b properly crosses any edge of any ring. Each edge runs
/// from the previous vertex to the current one, matching the TypeScript order.
pub fn segment_crosses_rings(a: [f64; 2], b: [f64; 2], rings: &Rings) -> bool {
    for ring in rings {
        let len = ring.len();
        if len == 0 {
            continue;
        }
        let mut j = len - 1;
        for i in 0..len {
            if segments_cross(a, b, ring[j], ring[i]) {
                return true;
            }
            j = i;
        }
    }
    false
}

/// Rhumb-line (loxodromic) distance between two positions, in meters.
fn rhumb_distance_meters(from: Position, to: Position) -> f64 {
    let latitude_from = to_radians(from.latitude);
    let latitude_to = to_radians(to.latitude);
    let delta_latitude = latitude_to - latitude_from;
    let delta_longitude = wrap_delta_longitude_rad(to_radians(to.longitude - from.longitude));

    let delta_isometric_latitude =
        isometric_latitude_rad(latitude_to) - isometric_latitude_rad(latitude_from);
    let q = if delta_isometric_latitude.abs() > EAST_WEST_ISOMETRIC_EPSILON {
        delta_latitude / delta_isometric_latitude
    } else {
        latitude_from.cos()
    };

    let angular_distance = (delta_latitude.powi(2) + (q * delta_longitude).powi(2)).sqrt();
    EARTH_RADIUS_METERS * angular_distance
}

/// Strictly interior sample points of a rhumb (constant-bearing) line, spaced
/// `spacing_meters` apart. Neither endpoint is included, so a leg shorter than one
/// spacing returns an empty vector. Panics when `spacing_meters` is not a finite
/// positive number, mirroring the TypeScript throw.
pub fn sample_rhumb_leg(from: Position, to: Position, spacing_meters: f64) -> Vec<Position> {
    if !spacing_meters.is_finite() || spacing_meters <= 0.0 {
        panic!("sample_rhumb_leg: spacing_meters must be a finite positive number");
    }

    let total_meters = rhumb_distance_meters(from, to);
    // Number of strictly-interior samples at this spacing. `ceil - 1` excludes the
    // endpoint even when the leg length is an exact multiple of the spacing.
    let step_count = (total_meters / spacing_meters).ceil() - 1.0;
    if step_count < 1.0 {
        return Vec::new();
    }

    let latitude_from = to_radians(from.latitude);
    let latitude_to = to_radians(to.latitude);
    let delta_latitude = latitude_to - latitude_from;
    let delta_longitude = wrap_delta_longitude_rad(to_radians(to.longitude - from.longitude));

    let isometric_from = isometric_latitude_rad(latitude_from);
    let delta_isometric_latitude = isometric_latitude_rad(latitude_to) - isometric_from;

    let longitude_from = to_radians(from.longitude);
    let east_west = delta_isometric_latitude.abs() <= EAST_WEST_ISOMETRIC_EPSILON;
    // Off the east-west case, longitude advances linearly with isometric latitude,
    // so the meters-per-isometric ratio is loop-invariant; hoist it once.
    let lon_per_iso = if east_west {
        0.0
    } else {
        delta_longitude / delta_isometric_latitude
    };

    let mut samples: Vec<Position> = Vec::new();
    let mut step = 1.0_f64;
    while step <= step_count {
        let fraction = (step * spacing_meters) / total_meters;
        // True latitude advances linearly with rhumb distance (the bearing is
        // constant), so interpolate it directly.
        let latitude_rad = latitude_from + fraction * delta_latitude;

        // Longitude advances linearly with isometric latitude, not true latitude,
        // so derive this sample's isometric latitude from its true latitude. On an
        // east-west leg the isometric change is zero (a 0/0), so step longitude
        // linearly along the parallel instead.
        let longitude_rad = if east_west {
            longitude_from + fraction * delta_longitude
        } else {
            let isometric_step = isometric_latitude_rad(latitude_rad);
            longitude_from + lon_per_iso * (isometric_step - isometric_from)
        };

        samples.push(Position {
            latitude: to_degrees(latitude_rad),
            longitude: normalize_longitude(to_degrees(longitude_rad)),
        });
        step += 1.0;
    }
    samples
}

/// Project a position along a great-circle path, given a start point, an initial
/// compass bearing, and a distance in kilometers.
fn project_position(position: Position, bearing_degrees: f64, distance_km: f64) -> Position {
    let latitude_rad = to_radians(position.latitude);
    let longitude_rad = to_radians(position.longitude);
    let bearing_rad = to_radians(bearing_degrees);
    let angular_distance = distance_km / EARTH_RADIUS_KM;

    // Clamp into [-1, 1] before asin: floating-point error can push this a hair
    // past the limit for a center extremely close to a pole, where asin is NaN.
    let sine_new_latitude = latitude_rad.sin() * angular_distance.cos()
        + latitude_rad.cos() * angular_distance.sin() * bearing_rad.cos();
    let new_latitude_rad = sine_new_latitude.min(1.0).max(-1.0).asin();

    let new_longitude_rad = longitude_rad
        + (bearing_rad.sin() * angular_distance.sin() * latitude_rad.cos()).atan2(
            angular_distance.cos() - latitude_rad.sin() * new_latitude_rad.sin(),
        );

    Position {
        latitude: to_degrees(new_latitude_rad),
        longitude: normalize_longitude(to_degrees(new_longitude_rad)),
    }
}

/// Build a bounding box that fully encloses a search circle of `distance_meters`
/// radius around the center. Panics on a non-finite coordinate or a non-finite or
/// negative radius, mirroring the TypeScript throw.
fn position_to_bbox(position: Position, distance_meters: f64) -> Bbox {
    if !position.latitude.is_finite() || !position.longitude.is_finite() {
        panic!("position_to_bbox: position carries a non-finite coordinate");
    }
    if !distance_meters.is_finite() || distance_meters < 0.0 {
        panic!("position_to_bbox: distance_meters must be a finite non-negative number");
    }
    // Corner-to-center distance for a square whose edges sit distance_meters out.
    let corner_distance_km = (distance_meters * std::f64::consts::SQRT_2) / 1000.0;
    let north_west = project_position(position, NW_BEARING_DEGREES, corner_distance_km);
    let south_east = project_position(position, SE_BEARING_DEGREES, corner_distance_km);

    Bbox {
        north: 90.0_f64.min(north_west.latitude),
        south: (-90.0_f64).max(south_east.latitude),
        east: south_east.longitude,
        west: north_west.longitude,
    }
}

/// The smallest bounding box that encloses both inputs. Panics on a non-finite
/// edge, mirroring the TypeScript throw.
pub(crate) fn union_bbox(a: Bbox, b: Bbox) -> Bbox {
    if !a.north.is_finite()
        || !a.south.is_finite()
        || !a.east.is_finite()
        || !a.west.is_finite()
        || !b.north.is_finite()
        || !b.south.is_finite()
        || !b.east.is_finite()
        || !b.west.is_finite()
    {
        panic!("union_bbox: input carries a non-finite edge");
    }
    Bbox {
        north: a.north.max(b.north),
        south: a.south.min(b.south),
        east: a.east.max(b.east),
        west: a.west.min(b.west),
    }
}

/// Union of each waypoint's bbox padded by `half_width_meters`. Panics on an empty
/// waypoint list, since there is no box to seed, mirroring the TypeScript throw.
pub fn route_bbox(waypoints: &[Position], half_width_meters: f64) -> Bbox {
    let mut bbox = position_to_bbox(waypoints[0], half_width_meters);
    for i in 1..waypoints.len() {
        bbox = union_bbox(bbox, position_to_bbox(waypoints[i], half_width_meters));
    }
    bbox
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(points: &[[f64; 2]]) -> Vec<[f64; 2]> {
        points.to_vec()
    }

    fn square() -> Rings {
        vec![ring(&[
            [-1.0, -1.0],
            [1.0, -1.0],
            [1.0, 1.0],
            [-1.0, 1.0],
            [-1.0, -1.0],
        ])]
    }

    // An outer square spanning [-1, 1] with an inner hole ring spanning [-0.5, 0.5].
    fn square_with_hole() -> Rings {
        vec![
            ring(&[
                [-1.0, -1.0],
                [1.0, -1.0],
                [1.0, 1.0],
                [-1.0, 1.0],
                [-1.0, -1.0],
            ]),
            ring(&[
                [-0.5, -0.5],
                [0.5, -0.5],
                [0.5, 0.5],
                [-0.5, 0.5],
                [-0.5, -0.5],
            ]),
        ]
    }

    #[test]
    fn point_in_rings_is_true_inside_and_false_outside_the_ring() {
        assert!(point_in_rings(0.0, 0.0, &square()));
        assert!(!point_in_rings(2.0, 2.0, &square()));
    }

    #[test]
    fn point_in_rings_treats_the_interior_of_a_hole_as_outside_the_polygon() {
        // Inside the hole is outside the polygon by the even-odd rule.
        assert!(!point_in_rings(0.0, 0.0, &square_with_hole()));
        // The solid band between the outer ring and the hole is inside the polygon.
        assert!(point_in_rings(0.75, 0.0, &square_with_hole()));
    }

    #[test]
    fn segments_cross_detects_a_proper_crossing_and_rejects_a_non_crossing_pair() {
        assert!(segments_cross(
            [-1.0, 0.0],
            [1.0, 0.0],
            [0.0, -1.0],
            [0.0, 1.0]
        ));
        assert!(!segments_cross(
            [-1.0, 0.0],
            [1.0, 0.0],
            [-1.0, 1.0],
            [1.0, 1.0]
        ));
    }

    #[test]
    fn segment_crosses_rings_is_true_when_a_segment_cuts_a_ring_edge() {
        assert!(segment_crosses_rings([-2.0, 0.0], [2.0, 0.0], &square()));
        assert!(!segment_crosses_rings([2.0, 2.0], [3.0, 3.0], &square()));
    }

    // The cases below cover the primitives the leg-geometry test file does not
    // exercise directly. The expected floating-point values are oracle values
    // captured from the TypeScript reference (node --import tsx). They are
    // compared within a small ULP tolerance rather than bit-exactly, so that
    // platform libm differences between aarch64 and amd64 do not produce false
    // failures; see design spec section 8.

    /// ULP tolerance for reference-derived float comparisons; see design spec section 8.
    const MAX_ORACLE_ULP_GAP: i64 = 2;

    fn assert_oracle_close(label: &str, a: f64, b: f64) {
        let gap = crate::provider::ulp_gap(a, b);
        assert!(
            gap <= MAX_ORACLE_ULP_GAP,
            "{label}: {a} differs from oracle {b} by {gap} ulp (max {MAX_ORACLE_ULP_GAP})"
        );
    }

    #[test]
    fn orient2d_sign_follows_the_turn_direction() {
        // Left turn is positive, right turn is negative, collinear is zero.
        assert!(orient2d([0.0, 0.0], [1.0, 0.0], [0.0, 1.0]) > 0.0);
        assert!(orient2d([0.0, 0.0], [1.0, 0.0], [0.0, -1.0]) < 0.0);
        assert_eq!(orient2d([0.0, 0.0], [1.0, 0.0], [2.0, 0.0]), 0.0);
    }

    #[test]
    fn bounds_of_rings_spans_every_vertex() {
        let b = bounds_of_rings(&square_with_hole());
        assert_eq!(b.north, 1.0);
        assert_eq!(b.south, -1.0);
        assert_eq!(b.east, 1.0);
        assert_eq!(b.west, -1.0);
    }

    #[test]
    fn meters_per_degree_lon_matches_the_reference() {
        // 111320 * cos(0) at the equator: exact by construction, not an oracle float.
        assert_eq!(meters_per_degree_lon(0.0), 111_320.0);
        // Oracle value at latitude 47.6 degrees from the TypeScript reference.
        assert_oracle_close("meters_per_degree_lon(47.6)", meters_per_degree_lon(47.6), 75_063.34178582008);
    }

    #[test]
    fn distance_meters_matches_the_reference() {
        let a = Position {
            latitude: 47.6,
            longitude: -122.4,
        };
        let b = Position {
            latitude: 47.62,
            longitude: -122.35,
        };
        // Oracle value from the TypeScript distanceMeters.
        assert_oracle_close("distance_meters(a,b)", distance_meters(a, b), 4358.322920633704);
        // A zero-length leg is exactly zero: structural check, not an oracle float.
        assert_eq!(distance_meters(a, a), 0.0);
    }

    #[test]
    fn sample_rhumb_leg_returns_empty_below_one_spacing() {
        let from = Position {
            latitude: 47.6,
            longitude: -122.4,
        };
        let to = Position {
            latitude: 47.6001,
            longitude: -122.4,
        };
        assert_eq!(sample_rhumb_leg(from, to, 1000.0), Vec::new());
    }

    #[test]
    fn sample_rhumb_leg_matches_the_reference() {
        let from = Position {
            latitude: 47.6,
            longitude: -122.4,
        };
        let to = Position {
            latitude: 47.65,
            longitude: -122.3,
        };
        let samples = sample_rhumb_leg(from, to, 2000.0);
        // Oracle samples from the TypeScript sampleRhumbLeg.
        let expected = vec![
            Position {
                latitude: 47.61071647312815,
                longitude: -122.37857510526305,
            },
            Position {
                latitude: 47.621432946256306,
                longitude: -122.35714581991357,
            },
            Position {
                latitude: 47.632149419384454,
                longitude: -122.33571214140153,
            },
            Position {
                latitude: 47.64286589251261,
                longitude: -122.31427406717529,
            },
        ];
        assert_eq!(samples.len(), expected.len(), "sample count mismatch");
        for (i, (a, e)) in samples.iter().zip(expected.iter()).enumerate() {
            assert_oracle_close(&format!("sample[{i}].latitude"), a.latitude, e.latitude);
            assert_oracle_close(&format!("sample[{i}].longitude"), a.longitude, e.longitude);
        }
    }

    #[test]
    fn route_bbox_matches_the_reference() {
        let waypoints = vec![
            Position {
                latitude: 47.6,
                longitude: -122.4,
            },
            Position {
                latitude: 47.65,
                longitude: -122.3,
            },
        ];
        let b = route_bbox(&waypoints, 3704.0);
        // Oracle edges from the TypeScript routeBbox.
        assert_oracle_close("route_bbox north", b.north, 47.683300240554374);
        assert_oracle_close("route_bbox south", b.south, 47.566678531871);
        assert_oracle_close("route_bbox east", b.east, -122.25058374813136);
        assert_oracle_close("route_bbox west", b.west, -122.44943196790138);
    }
}
