//! The navigable grid build, ported from `nav-grid.ts`: scanline rasterization,
//! the finer-band-wins rule, single-pass shore erosion, and the standoff BFS. The
//! resulting `NavGrid` implements `AStarGrid`. The scanline edge sort must be
//! stable and the fill boundary must use `ceil(x - 0.5)` and `floor(x - 0.5)`.
//!
//! `NavGridParams` is the channel-router-facing interface: it carries the standoff
//! in nautical miles and the optimize corridor as a bare polyline, and
//! `build_nav_grid` bakes the two router conventions that `channel-router.ts`
//! applies before its own `buildNavGrid` call, namely `standoff_meters =
//! standoff_nm * 1852` and a fixed one-nautical-mile corridor half-width. The
//! `target_cell_meters` and `osm_land` fields are additive so the unit tests can
//! reproduce the `nav-grid.ts` oracle fixtures faithfully; the router passes `None`
//! and an empty slice for them.

use crate::astar::AStarGrid;
use crate::geometry::{meters_per_degree_lon, METERS_PER_DEGREE};
use crate::types::{Bbox, ChartedAreas, Position, Ring, RingPolygon, TileWater};

/// Standoff cost weight: the step-cost multiplier at zero clearance, ramping to 0
/// at the desired offing.
const STANDOFF_WEIGHT: f64 = 6.0;
/// Default target cell size in meters; a larger bbox coarsens from here.
const DEFAULT_CELL_METERS: f64 = 60.0;
/// Cell-count ceiling; a larger bbox coarsens until it fits.
const MAX_CELLS: f64 = 250_000.0;
/// Cell-size ceiling; a route so large it would need coarser cells than this is
/// declined (too coarse to resolve a channel).
const MAX_CELL_METERS: f64 = 250.0;
/// Check the deadline this often during the standoff BFS.
const DEADLINE_CHECK_CELLS: usize = 8192;
/// Meters in one international nautical mile, exact by definition. Used to fold the
/// channel-router.ts `standoff_nm * METERS_PER_NAUTICAL_MILE` conversion into this
/// crate, since `NavGridParams` carries the standoff in nautical miles.
const METERS_PER_NAUTICAL_MILE: f64 = 1852.0;
/// Optimize-corridor half-width: channel-router.ts's `CORRIDOR_HALF_WIDTH_METERS`
/// (one nautical mile) folded in here, since `NavGridParams` carries only the
/// polyline and not the half-width the TypeScript `buildNavGrid` receives.
const CORRIDOR_HALF_WIDTH_METERS: f64 = METERS_PER_NAUTICAL_MILE;

/// Orthogonal neighbor offsets, in the order the TypeScript uses for the standoff
/// BFS and the erosion check: east, west, south, north.
pub const ORTHO_NEIGHBORS: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// The grid dimensions and the geographic transform resolved for a bbox.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GridSize {
    pub cols: usize,
    pub rows: usize,
    pub cell_meters: f64,
}

/// Inputs to `build_nav_grid`. ENC bands are finest first; tile water and foreign
/// rings are optional.
pub struct NavGridParams<'a> {
    pub bbox: Bbox,
    pub bands: &'a [ChartedAreas],
    pub tile_water: Option<&'a TileWater>,
    /// OSM land blockers (islands mapped as their own feature, explicit land). They
    /// block exactly like an ENC land area. The router passes an empty slice today;
    /// the field exists so the port carries the `nav-grid.ts` osmLand behavior.
    pub osm_land: &'a [RingPolygon],
    pub foreign_rings: &'a [RingPolygon],
    pub draft_meters: f64,
    pub safety_margin_meters: f64,
    pub standoff_nm: f64,
    pub corridor: Option<&'a [Position]>,
    /// Target cell size in meters, threaded to `resolve_grid_size`. `None` uses the
    /// 60 m default. The router passes `None`; the tests size a small grid with it.
    pub target_cell_meters: Option<f64>,
    pub deadline_ms: Option<f64>,
}

/// The navigable grid: a cell mask plus the standoff penalty, addressable as an
/// `AStarGrid`, with the geographic transform to map positions to and from cells.
pub struct NavGrid {
    cols: usize,
    rows: usize,
    cell_meters: f64,
    west: f64,
    north: f64,
    lon_span: f64,
    lat_span: f64,
    /// 1 where the cell is navigable, 0 otherwise; length `cols * rows`.
    navigable: Vec<u8>,
    /// BFS clearance in cells from the nearest blocked cell; -1 where unreached.
    clearance: Vec<i32>,
    /// Standoff offing in cells; 0 disables the standoff bias.
    desired_cells: f64,
    has_water: bool,
    /// True for the all-blocked 1x1 decline grid, so `cell_of` returns `(0, 0)`
    /// exactly like the TypeScript `emptyGrid`, even for a degenerate bbox span.
    empty: bool,
}

impl NavGrid {
    /// Cell containing the position, clamped to the grid.
    pub fn cell_of(&self, position: Position) -> (usize, usize) {
        if self.empty {
            return (0, 0);
        }
        let col = (((position.longitude - self.west) / self.lon_span) * self.cols as f64)
            .floor()
            .max(0.0)
            .min((self.cols - 1) as f64) as usize;
        let row = (((self.north - position.latitude) / self.lat_span) * self.rows as f64)
            .floor()
            .max(0.0)
            .min((self.rows - 1) as f64) as usize;
        (col, row)
    }

    /// Geographic center of the cell.
    pub fn cell_center(&self, cell: (usize, usize)) -> Position {
        let (col, row) = cell;
        Position {
            longitude: self.west + ((col as f64 + 0.5) / self.cols as f64) * self.lon_span,
            latitude: self.north - ((row as f64 + 0.5) / self.rows as f64) * self.lat_span,
        }
    }

    pub fn size(&self) -> GridSize {
        GridSize {
            cols: self.cols,
            rows: self.rows,
            cell_meters: self.cell_meters,
        }
    }

    /// True when at least one cell is navigable; false means the router must decline.
    pub fn has_water(&self) -> bool {
        self.has_water
    }
}

impl AStarGrid for NavGrid {
    fn cols(&self) -> usize {
        self.cols
    }
    fn rows(&self) -> usize {
        self.rows
    }
    fn is_navigable(&self, col: i64, row: i64) -> bool {
        col >= 0
            && (col as usize) < self.cols
            && row >= 0
            && (row as usize) < self.rows
            && self.navigable[(row as usize) * self.cols + col as usize] == 1
    }
    fn step_penalty(&self, col: i64, row: i64) -> f64 {
        if self.desired_cells <= 0.0 {
            return 0.0;
        }
        let cl = self.clearance[(row as usize) * self.cols + col as usize];
        if cl < 0 || cl as f64 >= self.desired_cells {
            return 0.0;
        }
        STANDOFF_WEIGHT * (1.0 - cl as f64 / self.desired_cells)
    }
}

/// The geographic-to-cell transform the scanline rasterizer reads: fractional
/// column and row of a coordinate.
struct GridTransform {
    west: f64,
    north: f64,
    lon_span: f64,
    lat_span: f64,
    cols: f64,
    rows: f64,
}

impl GridTransform {
    fn col_f(&self, lon: f64) -> f64 {
        ((lon - self.west) / self.lon_span) * self.cols
    }
    fn row_f(&self, lat: f64) -> f64 {
        ((self.north - lat) / self.lat_span) * self.rows
    }
}

/// Milliseconds since the Unix epoch, the `Date.now()` equivalent. The only
/// nondeterministic input; with `deadline_ms` set to `None` it is never read.
fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// True when a deadline is set and the wall clock has passed it.
fn over_deadline(deadline_ms: Option<f64>) -> bool {
    matches!(deadline_ms, Some(d) if now_ms() > d)
}

/// A safe all-blocked 1x1 grid for the decline paths (degenerate bbox, too-coarse,
/// or deadline). Its single cell center is the bbox center, and `cell_of` returns
/// `(0, 0)` for any input.
fn empty_grid(bbox: Bbox) -> NavGrid {
    NavGrid {
        cols: 1,
        rows: 1,
        cell_meters: DEFAULT_CELL_METERS,
        west: bbox.west,
        north: bbox.north,
        lon_span: bbox.east - bbox.west,
        lat_span: bbox.north - bbox.south,
        navigable: vec![0],
        clearance: vec![-1],
        desired_cells: 0.0,
        has_water: false,
        empty: true,
    }
}

/// Resolve the grid dimensions for a bbox, or `None` when the bbox is degenerate,
/// crosses the antimeridian, or is too large to tile. Used both by `build_nav_grid`
/// and by the router's pre-fetch decline so the two agree exactly.
pub fn resolve_grid_size(bbox: Bbox, target_cell_meters: Option<f64>) -> Option<GridSize> {
    let lon_span_deg = bbox.east - bbox.west;
    let lat_span_deg = bbox.north - bbox.south;
    if !(lon_span_deg > 0.0)
        || !(lat_span_deg > 0.0)
        || !lon_span_deg.is_finite()
        || !lat_span_deg.is_finite()
    {
        return None;
    }
    let mid_lat = (bbox.north + bbox.south) / 2.0;
    let width_meters = lon_span_deg * meters_per_degree_lon(mid_lat);
    let height_meters = lat_span_deg * METERS_PER_DEGREE;
    let mut cell = target_cell_meters.unwrap_or(DEFAULT_CELL_METERS);
    let mut cols = (width_meters / cell).ceil().max(1.0);
    let mut rows = (height_meters / cell).ceil().max(1.0);
    // Coarsen the cell geometrically until the grid fits the cap: 1.5x per step
    // converges in a few iterations while keeping resolution near the cap rather
    // than overshooting it the way a 2x step would.
    while cols * rows > MAX_CELLS {
        cell *= 1.5;
        cols = (width_meters / cell).ceil().max(1.0);
        rows = (height_meters / cell).ceil().max(1.0);
    }
    if cell > MAX_CELL_METERS {
        return None;
    }
    Some(GridSize {
        cols: cols as usize,
        rows: rows as usize,
        cell_meters: cell,
    })
}

/// Build the navigable grid from the charted areas, tile water, and foreign rings.
pub fn build_nav_grid(params: &NavGridParams) -> NavGrid {
    let size = match resolve_grid_size(params.bbox, params.target_cell_meters) {
        Some(s) => s,
        None => return empty_grid(params.bbox),
    };
    let cols = size.cols;
    let rows = size.rows;
    let cell = size.cell_meters;
    let n = cols * rows;

    let west = params.bbox.west;
    let north = params.bbox.north;
    let lon_span_deg = params.bbox.east - params.bbox.west;
    let lat_span_deg = params.bbox.north - params.bbox.south;
    let mid_lat = (params.bbox.north + params.bbox.south) / 2.0;
    let contour = params.draft_meters + params.safety_margin_meters;
    let deadline_ms = params.deadline_ms;

    let t = GridTransform {
        west,
        north,
        lon_span: lon_span_deg,
        lat_span: lat_span_deg,
        cols: cols as f64,
        rows: rows as f64,
    };

    let mut covered = vec![0u8; n];
    let mut blocked = vec![0u8; n];
    // Cells that are charted LAND (ENC land, an ENC drying area, OSM land, or a
    // tile-water island hole), the obstacles the route keeps clearance from. The
    // navigable region is eroded one cell off these below.
    let mut land_mask = vec![0u8; n];

    // Rasterize the ENC bands FINEST FIRST. A Depth_Area marks coverage; it also
    // blocks when its DRVAL1 is unknown, drying (<0), or shallower than the contour.
    // A Land_Area blocks. Within a band a shallow area wins over an overlapping deep
    // one (sticky OR). ACROSS bands a finer band wins per cell: a cell any finer band
    // already touched is skipped, so a coarse low-resolution shallow or zero-depth
    // area never overrides a fine band's charted deep channel.
    let mut decided = vec![0u8; n];
    let mut band_touched = vec![0u8; n];
    // Indices this band stamped, so propagating the finer-band decision and clearing
    // band_touched both run over the touched cells, not the whole grid, each band.
    let mut band_touched_list: Vec<usize> = Vec::new();

    for band in params.bands {
        band_touched_list.clear();
        for area in &band.depth_areas {
            let drval1 = area.depth_range.as_ref().and_then(|d| d.shallow_meters);
            let too_shallow = match drval1 {
                None => true,
                Some(v) => v < contour,
            };
            let drying = matches!(drval1, Some(v) if v < 0.0);
            let mut on_cell = |i: usize| {
                if band_touched[i] == 0 {
                    band_touched[i] = 1;
                    band_touched_list.push(i);
                }
                if decided[i] == 1 {
                    return;
                }
                covered[i] = 1;
                if too_shallow {
                    blocked[i] = 1;
                }
                if drying {
                    land_mask[i] = 1;
                }
            };
            if fill_polygon_cells(&area.rings, &t, cols, rows, &mut on_cell, deadline_ms) {
                return empty_grid(params.bbox);
            }
        }
        for area in &band.land_areas {
            let mut on_cell = |i: usize| {
                if band_touched[i] == 0 {
                    band_touched[i] = 1;
                    band_touched_list.push(i);
                }
                if decided[i] == 1 {
                    return;
                }
                blocked[i] = 1;
                land_mask[i] = 1;
            };
            if fill_polygon_cells(&area.rings, &t, cols, rows, &mut on_cell, deadline_ms) {
                return empty_grid(params.bbox);
            }
        }
        for &i in &band_touched_list {
            decided[i] = 1;
            band_touched[i] = 0;
        }
    }

    // OSM worldwide layer: water marks coverage only (depth-unknown, never blocks, so
    // an ENC-charted block on the same cell still wins), and land blocks exactly like
    // an ENC land area. Both stamp before the single navigable derivation, so any
    // block wins regardless of source order.
    let empty_tile_water = TileWater::default();
    let tile_water = params.tile_water.unwrap_or(&empty_tile_water);
    for poly in &tile_water.water {
        let mut on_cell = |i: usize| {
            covered[i] = 1;
        };
        if fill_polygon_cells(&poly.rings, &t, cols, rows, &mut on_cell, deadline_ms) {
            return empty_grid(params.bbox);
        }
    }
    for poly in params.osm_land {
        let mut on_cell = |i: usize| {
            blocked[i] = 1;
            land_mask[i] = 1;
        };
        if fill_polygon_cells(&poly.rings, &t, cols, rows, &mut on_cell, deadline_ms) {
            return empty_grid(params.bbox);
        }
    }
    // Foreign-water block (border-aware routing): keep a same-country route in its own
    // waters. The border is a jurisdictional line, not a physical shore, so this stamps
    // blocked only and NOT land_mask: the one-cell shore erosion below must not eat the
    // home-side channel a cell off the border. Stamping blocked before the navigable
    // derivation also makes the foreign water seed the standoff BFS.
    for poly in params.foreign_rings {
        let mut on_cell = |i: usize| {
            blocked[i] = 1;
        };
        if fill_polygon_cells(&poly.rings, &t, cols, rows, &mut on_cell, deadline_ms) {
            return empty_grid(params.bbox);
        }
    }
    // Tile-water island HOLES are land: the water fill excludes them by even-odd (so
    // they are uncovered, not navigable), but they must also mark land_mask so the
    // route keeps clearance from a small island.
    for poly in &tile_water.water {
        for h in 1..poly.rings.len() {
            let mut on_cell = |i: usize| {
                land_mask[i] = 1;
            };
            if fill_polygon_cells(
                std::slice::from_ref(&poly.rings[h]),
                &t,
                cols,
                rows,
                &mut on_cell,
                deadline_ms,
            ) {
                return empty_grid(params.bbox);
            }
        }
    }

    let mut navigable = vec![0u8; n];
    let mut has_water = false;
    for i in 0..n {
        if covered[i] == 1 && blocked[i] == 0 {
            navigable[i] = 1;
            has_water = true;
        }
    }

    // One-cell land clearance: drop a navigable cell orthogonally adjacent to charted
    // land (the land_mask), so the A* path stays a cell off the shore and a straight
    // leg between two navigable cell centers cannot clip a sub-cell land sliver the
    // full-resolution re-check would reject. Single forward row-major pass reading the
    // pre-erosion mask.
    if has_water {
        let nav_before = navigable.clone();
        has_water = false;
        for r in 0..rows {
            if over_deadline(deadline_ms) {
                return empty_grid(params.bbox);
            }
            for c in 0..cols {
                let i = r * cols + c;
                if nav_before[i] == 0 {
                    continue;
                }
                let mut near_land = false;
                for &(dc, dr) in ORTHO_NEIGHBORS.iter() {
                    let nc = c as i64 + dc;
                    let nr = r as i64 + dr;
                    if nc < 0 || nc >= cols as i64 || nr < 0 || nr >= rows as i64 {
                        continue;
                    }
                    if land_mask[(nr as usize) * cols + nc as usize] == 1 {
                        near_land = true;
                        break;
                    }
                }
                if near_land {
                    navigable[i] = 0;
                } else {
                    has_water = true;
                }
            }
        }
    }

    // Optimize corridor: restrict to cells within the half-width of the drawn polyline
    // (planar distance). channel-router.ts convention folded in: the router passes the
    // RAW polyline and this crate applies the fixed one-nautical-mile half-width
    // (CORRIDOR_HALF_WIDTH_METERS), exactly as channel-router.ts does before its own
    // buildNavGrid call. Not a port deviation.
    if let Some(polyline) = params.corridor {
        if has_water {
            let half = CORRIDOR_HALF_WIDTH_METERS;
            let mx = meters_per_degree_lon(mid_lat);
            let my = METERS_PER_DEGREE;
            has_water = false;
            for r in 0..rows {
                if over_deadline(deadline_ms) {
                    return empty_grid(params.bbox);
                }
                for c in 0..cols {
                    let i = r * cols + c;
                    if navigable[i] == 0 {
                        continue;
                    }
                    let center = Position {
                        longitude: west + ((c as f64 + 0.5) / cols as f64) * lon_span_deg,
                        latitude: north - ((r as f64 + 0.5) / rows as f64) * lat_span_deg,
                    };
                    if planar_point_to_polyline_meters(center, polyline, mx, my) <= half {
                        has_water = true;
                    } else {
                        navigable[i] = 0;
                    }
                }
            }
        }
    }

    // Standoff clearance: multi-source BFS in cell units from every BLOCKED cell over
    // navigable cells. Seed all non-navigable cells in index order, FIFO, ortho-neighbor
    // order east, west, south, north.
    let mut clearance = vec![-1_i32; n];
    let mut queue: Vec<usize> = Vec::with_capacity(n);
    for i in 0..n {
        if navigable[i] == 0 {
            clearance[i] = 0;
            queue.push(i);
        }
    }
    let mut head = 0;
    while head < queue.len() {
        if (head & (DEADLINE_CHECK_CELLS - 1)) == 0 && over_deadline(deadline_ms) {
            return empty_grid(params.bbox);
        }
        let i = queue[head];
        let r = i / cols;
        let c = i - r * cols;
        for &(dc, dr) in ORTHO_NEIGHBORS.iter() {
            let nc = c as i64 + dc;
            let nr = r as i64 + dr;
            if nc < 0 || nc >= cols as i64 || nr < 0 || nr >= rows as i64 {
                continue;
            }
            let ni = (nr as usize) * cols + nc as usize;
            if clearance[ni] != -1 {
                continue;
            }
            clearance[ni] = clearance[i] + 1;
            queue.push(ni);
        }
        head += 1;
    }

    // channel-router.ts convention folded in: the router passes the raw standoff in
    // nautical miles and this crate applies `standoff_nm * METERS_PER_NAUTICAL_MILE`,
    // exactly as channel-router.ts does before its own buildNavGrid call. Not a port
    // deviation: the channel_router must pass the RAW standoff_nm here, never a
    // pre-converted value.
    let standoff_meters = params.standoff_nm * METERS_PER_NAUTICAL_MILE;
    let desired_cells = if standoff_meters > 0.0 {
        standoff_meters / cell
    } else {
        0.0
    };

    NavGrid {
        cols,
        rows,
        cell_meters: cell,
        west,
        north,
        lon_span: lon_span_deg,
        lat_span: lat_span_deg,
        navigable,
        clearance,
        desired_cells,
        has_water,
        empty: false,
    }
}

/// Fill the cells whose CENTER lies inside the polygon (even-odd over all rings) by
/// scanline, calling `on_cell(index)` for each. Returns true if the deadline passed.
/// The edge crossings are sorted with a STABLE ascending sort, and the fill boundary
/// uses `ceil(x - 0.5)` for the left edge and `floor(x - 0.5)` for the right.
fn fill_polygon_cells(
    rings: &[Ring],
    t: &GridTransform,
    cols: usize,
    rows: usize,
    on_cell: &mut dyn FnMut(usize),
    deadline_ms: Option<f64>,
) -> bool {
    let mut edges: Vec<[f64; 4]> = Vec::new();
    let mut r_min = rows as f64;
    let mut r_max = -1.0_f64;
    for ring in rings {
        let len = ring.len();
        if len == 0 {
            continue;
        }
        let mut j = len - 1;
        for i in 0..len {
            let x0 = t.col_f(ring[j][0]);
            let y0 = t.row_f(ring[j][1]);
            let x1 = t.col_f(ring[i][0]);
            let y1 = t.row_f(ring[i][1]);
            edges.push([x0, y0, x1, y1]);
            r_min = r_min.min(y0.min(y1).floor());
            r_max = r_max.max(y0.max(y1).ceil());
            j = i;
        }
    }
    r_min = r_min.max(0.0);
    r_max = r_max.min((rows - 1) as f64);
    let r_start = r_min as i64;
    let r_end = r_max as i64;
    // Reused across rows (cleared each iteration) so the scanline does not allocate a
    // fresh vector per row.
    let mut xs: Vec<f64> = Vec::new();
    for row in r_start..=r_end {
        if ((row - r_start) & 255) == 0 {
            if let Some(d) = deadline_ms {
                if now_ms() > d {
                    return true;
                }
            }
        }
        let y = row as f64 + 0.5;
        xs.clear();
        for e in edges.iter() {
            let (x0, y0, x1, y1) = (e[0], e[1], e[2], e[3]);
            if (y0 > y) == (y1 > y) {
                continue;
            }
            xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        // Fill the columns whose cell CENTER (col + 0.5) falls inside each crossing
        // pair, hence the -0.5 shift: ceil for the left edge, floor for the right.
        let base = (row as usize) * cols;
        let mut k = 0;
        while k + 1 < xs.len() {
            let c_start = (xs[k] - 0.5).ceil().max(0.0) as i64;
            let c_end = (xs[k + 1] - 0.5).floor().min((cols - 1) as f64) as i64;
            let mut col = c_start;
            while col <= c_end {
                on_cell(base + col as usize);
                col += 1;
            }
            k += 2;
        }
    }
    false
}

/// Planar distance in meters from a point to a polyline, projecting at the given
/// meters-per-degree scales.
fn planar_point_to_polyline_meters(p: Position, polyline: &[Position], mx: f64, my: f64) -> f64 {
    if polyline.is_empty() {
        return f64::INFINITY;
    }
    let px = p.longitude * mx;
    let py = p.latitude * my;
    if polyline.len() == 1 {
        return (px - polyline[0].longitude * mx).hypot(py - polyline[0].latitude * my);
    }
    let mut best = f64::INFINITY;
    let mut i = 0;
    while i + 1 < polyline.len() {
        let ax = polyline[i].longitude * mx;
        let ay = polyline[i].latitude * my;
        let bx = polyline[i + 1].longitude * mx;
        let by = polyline[i + 1].latitude * my;
        let dx = bx - ax;
        let dy = by - ay;
        let len2 = dx * dx + dy * dy;
        let t = if len2 == 0.0 {
            0.0
        } else {
            (((px - ax) * dx + (py - ay) * dy) / len2).max(0.0).min(1.0)
        };
        let d = (px - (ax + t * dx)).hypot(py - (ay + t * dy));
        if d < best {
            best = d;
        }
        i += 1;
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AreaPolygon, DepthRange, EncAreaPolygon};

    fn bbox() -> Bbox {
        Bbox {
            west: 0.0,
            south: 0.0,
            east: 1.0,
            north: 1.0,
        }
    }

    /// A square ring `[lon, lat]`; pass `shallow` to make it a Depth_Area with that DRVAL1.
    fn box_area(w: f64, s: f64, e: f64, n: f64, shallow: Option<f64>) -> EncAreaPolygon {
        EncAreaPolygon {
            rings: vec![vec![[w, s], [e, s], [e, n], [w, n], [w, s]]],
            depth_range: shallow.map(|v| DepthRange {
                shallow_meters: Some(v),
                deep_meters: None,
            }),
        }
    }

    /// A square ring polygon (the structural shape OSM land and foreign water use).
    fn ring_poly(w: f64, s: f64, e: f64, n: f64) -> RingPolygon {
        RingPolygon {
            rings: vec![vec![[w, s], [e, s], [e, n], [w, n], [w, s]]],
        }
    }

    /// A square tile-water polygon (the structural shape the osmWater source uses).
    fn water_poly(w: f64, s: f64, e: f64, n: f64) -> AreaPolygon {
        AreaPolygon {
            rings: vec![vec![[w, s], [e, s], [e, n], [w, n], [w, s]]],
        }
    }

    fn no_enc() -> ChartedAreas {
        ChartedAreas {
            depth_areas: vec![],
            land_areas: vec![],
        }
    }

    /// The shared base: draft 2 m, margin 0.5 m, no standoff, 250 m cells.
    fn base_params<'a>(bbox: Bbox, bands: &'a [ChartedAreas]) -> NavGridParams<'a> {
        NavGridParams {
            bbox,
            bands,
            tile_water: None,
            osm_land: &[],
            foreign_rings: &[],
            draft_meters: 2.0,
            safety_margin_meters: 0.5,
            standoff_nm: 0.0,
            corridor: None,
            target_cell_meters: Some(250.0),
            deadline_ms: None,
        }
    }

    fn pos(lat: f64, lon: f64) -> Position {
        Position {
            latitude: lat,
            longitude: lon,
        }
    }

    fn nav_at(g: &NavGrid, lat: f64, lon: f64) -> bool {
        let (c, r) = g.cell_of(pos(lat, lon));
        g.is_navigable(c as i64, r as i64)
    }

    #[test]
    fn a_deep_depth_area_is_navigable_outside_it_is_blocked() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.2, 0.2, 0.8, 0.8, Some(10.0))],
            land_areas: vec![],
        }];
        let g = build_nav_grid(&base_params(bbox(), &bands));
        assert!(g.has_water());
        assert!(nav_at(&g, 0.5, 0.5));
        assert!(!nav_at(&g, 0.05, 0.05));
    }

    #[test]
    fn a_shallow_depth_area_is_blocked() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.2, 0.2, 0.8, 0.8, Some(1.0))],
            land_areas: vec![],
        }];
        let g = build_nav_grid(&base_params(bbox(), &bands));
        assert!(!nav_at(&g, 0.5, 0.5));
    }

    #[test]
    fn a_depth_area_with_no_drval1_is_blocked() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.2, 0.2, 0.8, 0.8, None)],
            land_areas: vec![],
        }];
        let g = build_nav_grid(&base_params(bbox(), &bands));
        assert!(!nav_at(&g, 0.5, 0.5));
    }

    #[test]
    fn a_drying_depth_area_is_blocked() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.2, 0.2, 0.8, 0.8, Some(-1.6))],
            land_areas: vec![],
        }];
        let g = build_nav_grid(&base_params(bbox(), &bands));
        assert!(!nav_at(&g, 0.5, 0.5));
    }

    #[test]
    fn a_land_area_inside_deep_water_is_blocked() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.1, 0.1, 0.9, 0.9, Some(10.0))],
            land_areas: vec![box_area(0.4, 0.4, 0.6, 0.6, None)],
        }];
        let g = build_nav_grid(&base_params(bbox(), &bands));
        assert!(!nav_at(&g, 0.5, 0.5));
        assert!(nav_at(&g, 0.2, 0.2));
    }

    #[test]
    fn overlapping_bands_the_shallow_reading_wins_regardless_of_stamp_order() {
        let deep = box_area(0.2, 0.2, 0.8, 0.8, Some(10.0));
        let shallow = box_area(0.2, 0.2, 0.8, 0.8, Some(1.0));
        let bands_a = [ChartedAreas {
            depth_areas: vec![deep.clone(), shallow.clone()],
            land_areas: vec![],
        }];
        let bands_b = [ChartedAreas {
            depth_areas: vec![shallow, deep],
            land_areas: vec![],
        }];
        let a = build_nav_grid(&base_params(bbox(), &bands_a));
        let b = build_nav_grid(&base_params(bbox(), &bands_b));
        assert!(!nav_at(&a, 0.5, 0.5));
        assert!(!nav_at(&b, 0.5, 0.5));
    }

    #[test]
    fn the_contour_boundary_is_inclusive() {
        let ok_bands = [ChartedAreas {
            depth_areas: vec![box_area(0.2, 0.2, 0.8, 0.8, Some(2.5))],
            land_areas: vec![],
        }];
        let low_bands = [ChartedAreas {
            depth_areas: vec![box_area(0.2, 0.2, 0.8, 0.8, Some(2.4))],
            land_areas: vec![],
        }];
        let ok_grid = build_nav_grid(&base_params(bbox(), &ok_bands));
        let low_grid = build_nav_grid(&base_params(bbox(), &low_bands));
        // Exactly draft + margin (2.5) is navigable; just below (2.4) is blocked.
        assert!(nav_at(&ok_grid, 0.5, 0.5));
        assert!(!nav_at(&low_grid, 0.5, 0.5));
    }

    #[test]
    fn cell_of_and_cell_center_round_trip_to_the_same_cell() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.0, 0.0, 1.0, 1.0, Some(10.0))],
            land_areas: vec![],
        }];
        let g = build_nav_grid(&base_params(bbox(), &bands));
        for p in [pos(0.5, 0.5), pos(0.13, 0.77), pos(0.9, 0.1)] {
            let cell = g.cell_of(p);
            assert_eq!(g.cell_of(g.cell_center(cell)), cell);
        }
    }

    #[test]
    fn the_standoff_cost_is_higher_near_shore_than_mid_channel() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.1, 0.1, 0.9, 0.9, Some(10.0))],
            land_areas: vec![],
        }];
        let mut params = base_params(bbox(), &bands);
        // The router passes nautical miles; build_nav_grid bakes the 1852 m/NM
        // conversion, so 5000 m of desired offing is 5000/1852 NM here.
        params.standoff_nm = 5000.0 / METERS_PER_NAUTICAL_MILE;
        let g = build_nav_grid(&params);
        let (mc, mr) = g.cell_of(pos(0.5, 0.5));
        let (ec, er) = g.cell_of(pos(0.13, 0.5));
        let mid = g.step_penalty(mc as i64, mr as i64);
        let edge = g.step_penalty(ec as i64, er as i64);
        assert!(edge > mid);
        assert!(edge > 0.0);
    }

    #[test]
    fn the_optimize_corridor_restricts_navigable_cells_to_near_the_polyline() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.0, 0.0, 1.0, 1.0, Some(10.0))],
            land_areas: vec![],
        }];
        let polyline = [pos(0.1, 0.1), pos(0.9, 0.9)];
        let mut params = base_params(bbox(), &bands);
        params.corridor = Some(&polyline);
        let g = build_nav_grid(&params);
        // On the diagonal stays navigable; the far corner is dropped. The router's
        // fixed one-nautical-mile half-width gives the same outcome as the TS fixture.
        assert!(nav_at(&g, 0.5, 0.5));
        assert!(!nav_at(&g, 0.9, 0.1));
    }

    #[test]
    fn a_finer_band_deep_area_wins_over_a_coarser_band_shallow_area() {
        // A coarse band returns one big DRVAL1=0 area over the whole window; a
        // sticky-OR merge would block the fine harbour deep channel.
        let bands = [
            ChartedAreas {
                depth_areas: vec![box_area(0.2, 0.2, 0.8, 0.8, Some(10.0))],
                land_areas: vec![],
            },
            ChartedAreas {
                depth_areas: vec![box_area(0.0, 0.0, 1.0, 1.0, Some(0.0))],
                land_areas: vec![],
            },
        ];
        let g = build_nav_grid(&base_params(bbox(), &bands));
        // Inside the fine deep area the finer band wins and it stays navigable.
        assert!(nav_at(&g, 0.5, 0.5));
        // A cell only the coarse shallow area covers is blocked.
        assert!(!nav_at(&g, 0.05, 0.05));
    }

    #[test]
    fn an_osm_water_polygon_alone_is_navigable() {
        let bands = [no_enc()];
        let tw = TileWater {
            water: vec![water_poly(0.2, 0.2, 0.8, 0.8)],
        };
        let mut params = base_params(bbox(), &bands);
        params.tile_water = Some(&tw);
        let g = build_nav_grid(&params);
        assert!(g.has_water());
        assert!(nav_at(&g, 0.5, 0.5));
        assert!(!nav_at(&g, 0.05, 0.05));
    }

    #[test]
    fn an_osm_land_island_over_osm_water_is_blocked() {
        let bands = [no_enc()];
        let tw = TileWater {
            water: vec![water_poly(0.1, 0.1, 0.9, 0.9)],
        };
        let lands = [ring_poly(0.4, 0.4, 0.6, 0.6)];
        let mut params = base_params(bbox(), &bands);
        params.tile_water = Some(&tw);
        params.osm_land = &lands;
        let g = build_nav_grid(&params);
        assert!(!nav_at(&g, 0.5, 0.5));
        assert!(nav_at(&g, 0.2, 0.2));
    }

    #[test]
    fn an_enc_land_area_blocks_over_osm_water() {
        let bands = [ChartedAreas {
            depth_areas: vec![],
            land_areas: vec![box_area(0.4, 0.4, 0.6, 0.6, None)],
        }];
        let tw = TileWater {
            water: vec![water_poly(0.1, 0.1, 0.9, 0.9)],
        };
        let mut params = base_params(bbox(), &bands);
        params.tile_water = Some(&tw);
        let g = build_nav_grid(&params);
        assert!(!nav_at(&g, 0.5, 0.5));
        assert!(nav_at(&g, 0.2, 0.2));
    }

    #[test]
    fn an_enc_shallow_depth_area_still_blocks_even_when_osm_maps_water() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.2, 0.2, 0.8, 0.8, Some(1.0))],
            land_areas: vec![],
        }];
        let tw = TileWater {
            water: vec![water_poly(0.2, 0.2, 0.8, 0.8)],
        };
        let mut params = base_params(bbox(), &bands);
        params.tile_water = Some(&tw);
        let g = build_nav_grid(&params);
        assert!(!nav_at(&g, 0.5, 0.5));
    }

    #[test]
    fn a_degenerate_or_antimeridian_crossing_bbox_declines() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.0, 0.0, 1.0, 1.0, Some(10.0))],
            land_areas: vec![],
        }];
        let degenerate = Bbox {
            west: 1.0,
            south: 0.0,
            east: 0.0,
            north: 1.0,
        };
        let g = build_nav_grid(&base_params(degenerate, &bands));
        assert!(!g.has_water());
    }

    #[test]
    fn a_bbox_too_large_to_resolve_at_the_cell_size_floor_declines() {
        let bands = [ChartedAreas {
            depth_areas: vec![box_area(0.0, 0.0, 50.0, 50.0, Some(10.0))],
            land_areas: vec![],
        }];
        let big = Bbox {
            west: 0.0,
            south: 0.0,
            east: 50.0,
            north: 50.0,
        };
        let mut params = base_params(big, &bands);
        // The too-large case uses the default cell (no target override), matching the
        // TS fixture, so it coarsens past the floor and declines.
        params.target_cell_meters = None;
        let g = build_nav_grid(&params);
        assert!(!g.has_water());
    }

    #[test]
    fn resolve_grid_size_rejects_degenerate_and_antimeridian_windows() {
        let degenerate = Bbox {
            west: 1.0,
            south: 0.0,
            east: 0.0,
            north: 1.0,
        };
        assert_eq!(resolve_grid_size(degenerate, Some(250.0)), None);
        let antimeridian = Bbox {
            west: 170.0,
            south: 0.0,
            east: -170.0,
            north: 1.0,
        };
        assert_eq!(resolve_grid_size(antimeridian, Some(250.0)), None);
    }

    #[test]
    fn resolve_grid_size_rejects_a_window_too_large_for_the_cell_floor() {
        let big = Bbox {
            west: 0.0,
            south: 0.0,
            east: 50.0,
            north: 50.0,
        };
        assert_eq!(resolve_grid_size(big, None), None);
    }

    #[test]
    fn resolve_grid_size_resolves_dimensions_for_a_normal_window() {
        let size = resolve_grid_size(bbox(), Some(250.0)).expect("resolves");
        assert_eq!(size.cols, 446);
        assert_eq!(size.rows, 446);
        assert_eq!(size.cell_meters, 250.0);
    }
}
