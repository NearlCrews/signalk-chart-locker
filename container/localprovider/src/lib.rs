//! Reads a per-region GeoPackage store and implements the engine's Provider trait.
//! No GDAL, GEOS, PROJ, or SpatiaLite: rusqlite with bundled SQLite plus the pure-Rust
//! binnacle-gpkg WKB decoder.

pub mod store;

pub use store::LocalProvider;

#[cfg(feature = "testutil")]
pub mod fixture;
