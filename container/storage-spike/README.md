# storage-spike

A milestone 1.5 tracer spike that retires the highest technical risk before the Rust engine port: proving that Rust with `rusqlite` (bundled SQLite, R-tree compiled in) can open a real OGC GeoPackage read-only, run an R-tree bounding-box query, and decode the GeoPackage geometry plus WKB with a pure-Rust decoder, on aarch64, with no GDAL, SpatiaLite, GEOS, or PROJ linked.

The verdict is in [VERDICT.md](VERDICT.md): PASS.

## Layout

- `gen_sample.py` generates a real GeoPackage sample (Natural Earth admin-0 50m) into `data/sample.gpkg`, plus ground-truth bbox vectors in `vectors.json`. Pure Python stdlib `sqlite3`, no GDAL. Deterministic and idempotent.
- `src/gpkg.rs`, `src/main.rs`, `Cargo.toml` are the Rust reader: open immutable read-only, R-tree query, pure-Rust GeoPackage and WKB decode.
- `verify.py` is an independent reference reader and cross-check (stdlib `sqlite3` only), with `oracle`, `structure`, `crosscheck`, and `all` modes.
- `data/` holds the generated sample and its cached source. It is git-ignored and is never committed or shipped in a tarball.

## Regenerate and run

```sh
# 1. Generate the sample and vectors (writes data/sample.gpkg and rewrites vectors.json):
python3 gen_sample.py

# 2. Build and test the Rust reader:
cargo test
cargo build --release

# 3. Query a bounding box (minx miny maxx maxy), default db is data/sample.gpkg:
./target/release/storage-spike -8.0 50.0 2.0 58.0

# 4. Independent verification, structure plus oracle plus cross-check against the binary:
python3 verify.py all --gpkg data/sample.gpkg --vectors vectors.json --ferro ./target/release/storage-spike
```

## What it does not cover

The R-tree candidate set and geometry decode only. Exact point-in-polygon refinement is the engine's job, out of spike scope. A first internet run downloads the Natural Earth source into `data/` and caches it for offline reruns.
