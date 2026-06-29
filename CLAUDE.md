# CLAUDE.md

Guidance for Claude Code working in `signalk-chart-locker`.

## Working style for this project (standing rules)

- Use caveman **ultra** mode for all responses in this project (terse, abbreviated prose,
  arrows for causality, code and API names and error strings kept verbatim). Drop caveman only
  for security warnings, irreversible-action confirmations, and multi-step sequences where
  compression risks misread.
- **Always delegate to a cavecrew** subagent (`cavecrew-investigator` to locate code,
  `cavecrew-builder` for a one-to-two-file edit, `cavecrew-reviewer` to review a diff or file)
  unless told otherwise. Use a Bash-capable general agent only when the cavecrew genuinely cannot
  do the job (for example a task that must compile and run `cargo` to verify itself).
- On-demand Rust review: the `rust-signalk-expert` agent (`.claude/agents/`) knows the tilecache
  crate, the no-heavy-native-libs runtime rule, and the Signal K container seam. Invoke it to
  review or advise on the Rust.
- Keep everything consistent, modular, and following best practices. Match the surrounding style
  and idioms; hoist shared logic into one place (a shared crate, helper, or module) instead of
  duplicating; prefer data-driven structures over parallel hard-coded lists; and leave every change
  self-consistent (build, tests, clippy, and lint green). The Rust is one Cargo workspace with one
  member (`tilecache`): extend that seam, never fork it.
- **Review every implementation plan with a team of 2 agents before finalizing it**, using independent
  lenses (for example correctness and the trust boundary, plus plan quality and codebase fit), then fix
  every finding of every severity before execution. A plan does not go to execution unreviewed.
- **Design every panel build or change with a team of UI/UX experts** (lead with `signalk-ui-designer`
  plus a second reviewer), kept consistent with the other panels in the project: the same control
  primitives, shared design tokens and themes, section layout, label voice, and spacing. Reuse the
  existing control primitive for a field an existing one already covers; never introduce a one-off.

## What this is

A Signal K companion that runs a Rust container alongside the server to host tile caching and
local chart serving. It is ONE npm package (the thin Node plugin) plus one container build
artifact (the `tilecache` crate under `container/`), in one repo. Container lifecycle is
delegated to the installed `signalk-container` plugin.

## Architecture rules (do not violate)

- One npm package, modular TypeScript under `src/`. The container is a build artifact, not an
  npm package. Never split into multiple npm packages or a monorepo.
- The container is tokenless and Signal K agnostic. Only the in-process plugin talks to it,
  reached via `signalk-container`'s `resolveContainerAddress` after `ensureRunning` with
  `signalkAccessiblePorts` (never a manual `ports` or `networkMode`).
- The runtime image carries no GDAL, GEOS, PROJ, SpatiaLite, or other heavy native libraries.
  The tilecache binary links only against libc, libm, libgcc, and the loader.
- Local PMTiles chart files are served by the Node plugin (strong file-identity ETag, HTTP Range
  support), never mounted into or served by the egress tilecache container. Mounting them there
  would either add a redundant cache layer or expose the Signal K config tree (including
  `security.json`) to the internet-facing container.
- Units are SI internally (meters, radians, Kelvin); convert only at a display edge.
- Note: `container/.cargo/config.toml` disables FMA contraction on x86_64. That flag was added
  for the engine parity contract and is now vestigial; it is harmless and left in place.

## Layout and status

- `src/`, `test/`: the Node plugin. Lifecycle, the `signalk-container` consumer, the tile proxy
  and streaming, the PMTiles chart provider, and the regions and chart-management route handlers.
- `container/`: one Cargo workspace (`container/Cargo.toml`) with one member: `tilecache`.
- `container/tilecache/`: the egress-isolated reverse proxy and disk cache for allowlisted raster
  overlays and the vector basemap. Reads and writes a microSD-aware SQLite tile cache. Includes
  the warm-job engine: a server-side budget gate (R is a ceiling on the pinned region bytes, not space
  pre-reserved from the scroll cache), box pinning so a region download evicts only unpinned scroll
  tiles and never a pinned tile, a per-source average-size tracker, a concurrent warm-job cap, and a
  lazy tile enumerator. It also runs a scroll-tile age sweep (a configurable TTL reclaims unpinned
  tiles not viewed within the window, at startup and on an hourly timer) and an on-demand clear of all
  unpinned scroll tiles, both in bounded chunks and both leaving pinned tiles untouched.
- `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/superpowers/reviews/`: design
  specs, plans, and review records. The router-engine milestone docs (M1 through M4) are kept as
  historical records; the routing work was removed 2026-06-29.

## Build and test

- Plugin: `npm test` (node --test via tsx), `npm run typecheck`, `npm run lint`, `npm run build`.
- Rust (Cargo workspace): `cd container && cargo test --workspace` (first build is slow on the Pi;
  allow a long timeout), then `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo build --release --bin tilecache`.
- No `prepare` or `prepack` lifecycle script in `package.json` (it corrupts the App Store
  install-simulation CI step).
