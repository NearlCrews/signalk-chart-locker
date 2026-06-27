# Storage tracer spike: verdict

**Result: PASS.** On aarch64 (this Raspberry Pi), Rust with `rusqlite` (bundled SQLite, R-tree compiled in) opens a real OGC GeoPackage read-only, runs an R-tree bounding-box query, and decodes the GeoPackage geometry blob plus WKB with a pure-Rust decoder, returning exactly what an independent reference reader returns. No libgdal, libspatialite, libgeos, or libproj is linked. The highest technical risk before the Rust engine port is retired.

## What was proven (the four goal points)

1. **Open immutable read-only on aarch64.** `Connection::open_with_flags("file:<path>?immutable=1", SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_URI)` opens the sample with no WAL and no sidecar files. An `immutable=1` open also succeeds on a `chmod 0444` file and writes are refused, so a read-only mount is supported.
2. **R-tree bounding-box query.** The contract query against `rtree_regions_geom` returns the correct candidate fids for every test vector.
3. **Pure-Rust GeoPackage and WKB decode, no geospatial C libraries.** `src/gpkg.rs` decodes the GeoPackage binary header (both byte orders, envelope indicators 0 through 4) and ISO WKB Polygon and MultiPolygon (both byte orders, including holes), with a bounds-checked cursor so a corrupt length cannot over-allocate. `ldd` on the release binary shows only `linux-vdso`, `libgcc_s`, `libm`, `libc`, and `ld-linux-aarch64`: no gdal, spatialite, geos, proj, or even a system libsqlite3 (SQLite is statically bundled).
4. **Results match an independent reader.** A separately written Python reference reader (stdlib `sqlite3` only, no shared code with the Rust side) reproduces the same fid sets and the same decoded geometry, and the Rust binary agrees with it on every vector.

## Evidence

| Item | Value |
| --- | --- |
| Architecture | aarch64 (`aarch64-unknown-linux-gnu`) |
| Rust binary | `target/release/storage-spike`, 2.7 MB |
| `ldd` of the binary | linux-vdso, libgcc_s, libm, libc, ld-linux-aarch64 only; zero matches for gdal, spatialite, geos, proj, sqlite |
| SQLite (Rust) | bundled 3.45.0 via libsqlite3-sys 0.28, rusqlite 0.31 |
| SQLite (reference reader) | 3.46.1 (system Python stdlib) |
| Rust tests | 14 passed, 0 failed (9 decoder, 4 arg-parse, 1 real-sample integration) |
| Sample | `data/sample.gpkg`, Natural Earth admin-0 50m v5.1.2, 774 features, 1.94 MB, md5 698c41e61c71c5816908dddbbe33d812 |
| Whole-file decode | all 774 features decode: 663 Polygon, 111 MultiPolygon, 99,613 vertices, matching the generator counts to the vertex |
| GeoPackage authenticity | `application_id` 0x47504B47, `user_version` 10301, the three required gpkg_* tables present, feature count 774 == rtree count 774; GDAL `ogrinfo` via podman also opens it as a GPKG |

## Per-vector cross-check (Rust binary versus independent Python oracle)

| Vector | Case | Expected fids | Rust binary | Python oracle |
| --- | --- | --- | --- | --- |
| hit_british_isles | hit | 343, 377, 378, 443, 634 | match | match |
| miss_north_pacific | miss | (none) | match | match |
| partial_central_mediterranean | partial | 135, 298, 380, 588, 765 | match | match |
| boundary_touch_iceland_west | boundary | 358, 371 | match | match |
| boundary_just_outside_iceland_west | miss | 358 | match | match |

The last two vectors are the same box shifted one float unit west: Iceland (fid 371) is in the candidate set when the query's eastern edge equals Iceland's western envelope edge under the inclusive comparison, and drops one ulp later, so the boundary decides inclusion.

## Scope and honesty

This proves the storage read path: open, R-tree candidate query, and geometry decode. It is the R-tree candidate set only. Large envelopes are intentionally over-inclusive (Greenland, fid 358, appears in the Iceland-area boxes because its envelope spans them). Exact point-in-polygon refinement is the engine's job and is out of spike scope. Byte-identity of the regenerated sample is guaranteed only for a given SQLite library version; the logical content and the query results are stable across versions.
