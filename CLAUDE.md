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
- Keep everything consistent, modular, and following best practices. Match the surrounding style
  and idioms; hoist shared logic into one place (a shared crate, helper, or module) instead of
  duplicating; prefer data-driven structures over parallel hard-coded lists; and leave every change
  self-consistent (build, tests, clippy, and lint green). The Rust is one Cargo workspace, the
  GeoPackage and WKB decoder lives only in `binnacle-gpkg`, and the prep store schema and ENC
  ingests are single sources (`TABLE_SCHEMAS`, `ENC_INGESTS`): extend those seams, never fork them.
- **Review every implementation plan with a team of 2 agents before finalizing it**, using independent
  lenses (for example correctness and the trust boundary, plus plan quality and codebase fit), then fix
  every finding of every severity before execution. A plan does not go to execution unreviewed.
- **Design every panel build or change with a team of UI/UX experts** (lead with `signalk-ui-designer`
  plus a second reviewer), kept consistent with the other panels in the project: the same control
  primitives, shared design tokens and themes, section layout, label voice, and spacing. Reuse the
  existing control primitive for a field an existing one already covers; never introduce a one-off.

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
- Deterministic numerics: FMA contraction disabled on x86_64 (`container/.cargo/config.toml`, the
  Cargo workspace root, so the flag applies to every crate compiled into any binary),
  with aarch64 relying on Rust's default of no FMA contraction and no fast-math; expression order
  preserved, `total_cmp` not `partial_cmp().unwrap()` on any sort that a non-finite float could reach.
- The trust boundary stays in crows-nest: the LLM call, the Signal K reads, the budget and admin
  gate, the depth-authority precedence, and all honesty wording. The container computes geometry
  only and must never make a route read as safer than the data supports.
- Units are SI internally (meters, radians, Kelvin); convert only at a display edge.
- Local PMTiles chart files are served by the Node plugin (strong file-identity ETag, HTTP Range
  support), never mounted into or served by the egress tilecache container. Mounting them there
  would either add a redundant cache layer or expose the Signal K config tree (including
  `security.json`) to the internet-facing container.
- Border-aware routing's `boundaries` table is sourced from Marine Regions EEZ with
  `country_id = iso_sov1` (ISO alpha-3), never admin-0 land. Land polygons cover no navigable
  water, so a foreign-water block built from them is a silent no-op, the worst failure for a
  trust-boundary feature. The Milestone 4 caller passes `homeCountryId` as the same alpha-3 code.
  Resolved 2026-06-27; see `docs/superpowers/decisions/2026-06-27-border-aware-boundaries-source.md`.

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
- The Rust crates under `container/` are one Cargo workspace (`container/Cargo.toml`): `engine`,
  `gpkg`, `localprovider`, `router`, `storage-spike`, and `tilecache`, sharing one lock, one target
  dir, and the root `container/.cargo/config.toml`. This is a Cargo workspace, not an npm monorepo.
- `container/router/`: the Milestone 1 axum service (`/health`, `/regions`, distroless image).
- `container/storage-spike/`: the Milestone 1.5 offline-GeoPackage-from-Rust proof, kept as a
  record; it reads through the shared `binnacle-gpkg` decoder.
- `container/engine/`: the Milestone 2 channel-router port and parity corpus (materially complete).
- `container/gpkg/`: the shared pure-Rust GeoPackage and WKB decoder (`binnacle-gpkg`), used by
  `localprovider` and `storage-spike` so the decoder lives in one place.
- `container/localprovider/`: the Milestone 3A runtime read path: reads an offline OGC GeoPackage
  via `rusqlite` and the `binnacle-gpkg` decoder, answers the engine's provider queries, and is
  wired into the router via `BINNACLE_REGION_STORE`. The `testutil` feature exposes a `StoreBuilder`.
- `container/prep/`: the Milestone 3B offline prep tool: a pinned-GDAL container that reads
  NOAA ENC S-57 cells and Marine Regions EEZ and OSM sources and writes a per-region GeoPackage in
  the `LocalProvider` schema. GDAL lives only here, never in the runtime image.
- `container/tilecache/`: the egress-isolated reverse proxy and disk cache for allowlisted raster
  overlays and the vector basemap. A separate image from the zero-egress engine container. Reads and
  writes a microSD-aware SQLite tile cache. v2 adds the warm-job engine: server-side cap
  enforcement, box pinning so a prewarm never evicts cached tiles, a per-source average-size
  tracker, a concurrent warm-job cap, and a lazy tile enumerator. v1 is on `main`; v2 is on
  `feat/tilecache-v2-v3` pending the owner-run release.
- `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/superpowers/reviews/`: the design
  spec, the per-milestone plans, and review records.

Milestone 3B's ENC core is implemented and verified against real NOAA cells (the prep tool
builds stores the runtime router routes over, avoiding charted land). Milestone 3C's
classification parity passed against the live NOAA ENC Direct service (`container/prep/data_parity.py`,
verified on San Francisco Bay). Remaining: OSM water at scale, multi-cell precedence, the 3C
one-way leg safety invariant, and broader regions. Milestone 4 (the crows-nest cutover behind the
`routeDraftUseCompanion` flag with an in-process fallback) is implemented in `signalk-crows-nest`
on branch `feat/m4-companion-cutover` (gates green, not yet merged or released); see
`docs/superpowers/plans/2026-06-27-companion-milestone-4-crows-nest-cutover.md` and the M3 handoff.

Tile cache v1 (raster and basemap proxy and cache) is on `main`. Tile cache v2 (the manual
prewarm bounding-box warm and the throttled off-plan position-warm, with bounded microSD writes)
and v3 (the PMTiles chart provider, implemented in the Node plugin) are on `feat/tilecache-v2-v3`,
pending the owner-run release sequence. The v3 PMTiles provider supersedes the third-party
`signalk-pmtiles-plugin` via real mutual exclusion enforced at plugin start.

To resume in a fresh session, start from `docs/superpowers/2026-06-27-m3-handoff.md`: it is the
single continuation guide (current state, the repo map, build and run and prep commands, the
remaining work with the plan to follow, the decisions in force, the gotchas, and the boat-only
tests).

## Build and test

- Plugin: `npm test` (node --test via tsx), `npm run typecheck`, `npm run lint`, `npm run build`.
- Rust (Cargo workspace): `cd container && cargo test --workspace` (first build is slow on the Pi;
  allow a long timeout), plus `cargo test -p binnacle-localprovider --features testutil` for its
  feature-gated tests and `cargo test -p binnacle-tilecache` for the tilecache crate, then
  `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo build --release --bin router --bin tilecache`.
- No `prepare` or `prepack` lifecycle script in `package.json` (it corrupts the App Store
  install-simulation CI step).
