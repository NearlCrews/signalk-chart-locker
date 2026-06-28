//! The Binnacle Companion tile cache and proxy: a tokenless reverse proxy and disk cache for the
//! allowlisted raster chart overlays and the vector basemap. This is the one container with internet
//! egress; the routing engine stays in its own offline image.

pub mod cache;
