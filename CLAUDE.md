# CLAUDE.md

Guidance for Claude Code working in `signalk-binnacle-companion`.

## Working style for this project (standing rules)

- Use caveman **ultra** mode for all responses in this project (terse, abbreviated prose,
  arrows for causality, code and API names and error strings kept verbatim). Drop caveman only
  for security warnings, irreversible-action confirmations, and multi-step sequences where
  compression risks misread.
- **Always delegate to a cavecrew** subagent (`cavecrew-investigator` to locate code,
  `cavecrew-builder` for a one-to-two-file edit, `cavecrew-reviewer` to review a diff or file)
  unless told otherwise. Use a Bash-capable general agent only when the cavecrew genuinely cannot
  do the job (for example a task that must compile and run `cargo` to verify itself).
- On-demand Rust review: the `rust-signalk-expert` agent (`.claude/agents/`) knows the engine
  crate, the parity contract, the no-heavy-native-libs runtime rule, and the Signal K container
  seam. Invoke it to review or advise on the Rust.

## What this is

A Signal K companion that runs a polyglot container alongside the server to escape the JS/TS
native-plugin sandbox. It is ONE npm package (the thin Node plugin) plus container build
artifacts (the Rust crates under `container/`), in one repo. Container lifecycle is delegated to
the installed `signalk-container` plugin. The first migration target is the crows-nest channel
router, ported to Rust with a fully offline local geodata store.

## Architecture rules (do not violate)

- One npm package, modular TypeScript under `src/`. The containers are build artifacts, not npm
  packages. Never split into multiple npm packages or a monorepo.
- The caller (crows-nest) reaches routing through an in-process bridge
  `globalThis.__signalk_binnacle_routeOnWater`, never an HTTP call from crows-nest to the plugin.
- The container is tokenless and Signal K agnostic. Only the in-process plugin talks to it,
  reached via `signalk-container`'s `resolveContainerAddress` after `ensureRunning` with
  `signalkAccessiblePorts` (never a manual `ports` or `networkMode`).
- The runtime image carries no GDAL, GEOS, PROJ, or SpatiaLite. GeoPackage reads use `rusqlite`
  with the `bundled` feature plus a pure-Rust WKB decoder; GDAL is confined to the offline prep
  stage of the geodata milestone. The engine is hand-ported, not built on the `geo` or
  `pathfinding` crates, whose predicates and tie-breaks break parity.
- ENC and chart data are never bundled in the image or the repo. The companion ships the GDAL
  S-57 to GeoPackage prep pipeline only; the owner downloads NOAA ENC cells per region and runs
  prep locally. This is the resolved Milestone 3 ENC distribution decision (Option A,
  pipeline-only, 2026-06-27): ship the pipeline, not the data. See
  `docs/superpowers/decisions/2026-06-27-enc-distribution-model.md`.
- Deterministic numerics: FMA contraction disabled on x86_64 (`container/engine/.cargo/config.toml`),
  with aarch64 relying on Rust's default of no FMA contraction and no fast-math; expression order
  preserved, `total_cmp` not `partial_cmp().unwrap()` on any sort that a non-finite float could reach.
- The trust boundary stays in crows-nest: the LLM call, the Signal K reads, the budget and admin
  gate, the depth-authority precedence, and all honesty wording. The container computes geometry
  only and must never make a route read as safer than the data supports.
- Units are SI internally (meters, radians, Kelvin); convert only at a display edge.

## Parity bar (resolved: 2-ULP tolerance)

The engine parity bar compares waypoint longitude and latitude within a 2-ULP per-coordinate
tolerance, per design spec section 8, while `usedTileWater`, `borderFallback`, and the decline
reasons match exactly. This resolves the earlier plan-versus-spec tension in favor of the spec:
libm transcendentals differ by ULPs across platforms, so the prior bit-exact bar could not hold on
an amd64 CI host against an aarch64-generated corpus. The 2-ULP bar still catches any real
regression (a divergence beyond a handful of ULP is always a logic error). The engine CI job runs
on both amd64 and arm64.

## Layout and status

- `src/`, `test/`: the Node plugin (Milestone 1, complete, on `main`).
- `container/router/`: the Milestone 1 axum service (`/health`, `/regions`, distroless image).
- `container/storage-spike/`: the Milestone 1.5 offline-GeoPackage-from-Rust proof.
- `container/engine/`: the Milestone 2 channel-router port and parity corpus (materially complete).
- `container/localprovider/`: the Milestone 3A runtime read path: reads an offline OGC GeoPackage
  via `rusqlite`, answers the engine's provider queries, and is wired into the router via
  `BINNACLE_REGION_STORE`. The `testutil` feature exposes a `StoreBuilder` for integration tests.
- `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/superpowers/reviews/`: the design
  spec, the per-milestone plans, and review records.

Milestone 3B (the S-57 to GeoPackage prep pipeline) and 3C (data-parity harness) are next.
Milestone 4 is the crows-nest cutover behind a feature flag with an in-process fallback.

## Build and test

- Plugin: `npm test` (node --test via tsx), `npm run typecheck`, `npm run lint`, `npm run build`.
- Rust: `cd container/engine && cargo test` (first build is slow on the Pi; allow a long timeout),
  `cargo clippy --all-targets -- -D warnings`, `cargo build --release`. Likewise in
  `container/router` and `container/storage-spike`.
- No `prepare` or `prepack` lifecycle script in `package.json` (it corrupts the App Store
  install-simulation CI step).
