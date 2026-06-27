//! The binnacle routing engine: a hand-port of the crows-nest channel router.
//!
//! This crate reproduces the TypeScript channel router exactly. With no deadline
//! the router is a pure function of its request and the provider responses, so the
//! port is validated bit-for-bit against the TypeScript reference on a replay corpus.
//! See `docs/superpowers/plans/2026-06-27-companion-milestone-2-engine-port.md`.

pub mod types;
pub mod geometry;
pub mod path_simplify;
pub mod astar;
pub mod nav_grid;
pub mod channel_router;
pub mod provider;

pub use channel_router::route_channel;
pub use types::*;
