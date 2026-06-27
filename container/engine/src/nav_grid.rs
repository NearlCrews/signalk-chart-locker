//! The navigable grid build, ported from `nav-grid.ts`: scanline rasterization,
//! the finer-band-wins rule, single-pass shore erosion, and the standoff BFS. The
//! resulting `NavGrid` implements `AStarGrid`. The scanline edge sort must be
//! stable and the fill boundary must use `ceil(x - 0.5)` and `floor(x - 0.5)`.

use crate::astar::AStarGrid;
use crate::types::{Bbox, ChartedAreas, Position, RingPolygon, TileWater};

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
    pub foreign_rings: &'a [RingPolygon],
    pub draft_meters: f64,
    pub safety_margin_meters: f64,
    pub standoff_nm: f64,
    pub corridor: Option<&'a [Position]>,
    pub deadline_ms: Option<f64>,
}

/// The navigable grid: a cell mask plus the standoff penalty, addressable as an
/// `AStarGrid`, with the geographic transform to map positions to and from cells.
pub struct NavGrid {
    // Fields are defined by the port; kept private to the module.
    _private: (),
}

impl NavGrid {
    /// Cell containing the position, clamped to the grid.
    pub fn cell_of(&self, position: Position) -> (usize, usize) {
        todo!("port cellOf from nav-grid.ts")
    }

    /// Geographic center of the cell.
    pub fn cell_center(&self, cell: (usize, usize)) -> Position {
        todo!("port cellCenter from nav-grid.ts")
    }

    pub fn size(&self) -> GridSize {
        todo!("expose the resolved grid size")
    }
}

impl AStarGrid for NavGrid {
    fn cols(&self) -> usize {
        todo!()
    }
    fn rows(&self) -> usize {
        todo!()
    }
    fn is_navigable(&self, col: i64, row: i64) -> bool {
        todo!()
    }
    fn step_penalty(&self, col: i64, row: i64) -> f64 {
        todo!()
    }
}

/// Resolve the grid dimensions for a bbox, or `None` when the bbox is degenerate,
/// crosses the antimeridian, or is too large to tile. Used both by `build_nav_grid`
/// and by the router's pre-fetch decline so the two agree exactly.
pub fn resolve_grid_size(bbox: Bbox, target_cell_meters: Option<f64>) -> Option<GridSize> {
    todo!("port resolveGridSize from nav-grid.ts")
}

/// Build the navigable grid from the charted areas, tile water, and foreign rings.
pub fn build_nav_grid(params: &NavGridParams) -> NavGrid {
    todo!("port buildNavGrid from nav-grid.ts")
}
