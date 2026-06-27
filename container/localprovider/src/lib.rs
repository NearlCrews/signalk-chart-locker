//! Reads a per-region GeoPackage store and implements the engine's Provider trait.
//! No GDAL, GEOS, PROJ, or SpatiaLite: rusqlite with bundled SQLite plus a pure-Rust
//! WKB decoder, exactly the read path proven in the Milestone 1.5 storage spike.

pub mod gpkg;
pub mod store;

pub use store::LocalProvider;

#[cfg(feature = "testutil")]
pub mod fixture;
