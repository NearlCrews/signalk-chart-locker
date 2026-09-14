# Project guide

This file is retained for compatibility with development tools that look for `CLAUDE.md`. The
maintained user and operator documentation is in the [README](README.md),
[operations guide](docs/OPERATIONS.md), [HTTP API reference](docs/API.md), and
[security policy](.github/SECURITY.md).

## Architecture

Chart Locker ships one npm package and one coordinated container image:

- TypeScript under `src/` implements the Signal K plugin, configuration panel, PMTiles discovery and
  serving, management routes, durable JSON state, and browser-facing proxies.
- `container/tilecache/` implements the Rust tile-cache service in the single-member Cargo workspace
  under `container/`.
- Container lifecycle is delegated to `signalk-container`. Do not add direct Podman or Docker process
  management to the plugin.

The container is Signal K agnostic. Only the plugin communicates with it through the private address
returned by `resolveContainerAddress`, and every mutating control request carries the plugin's private,
persistent control token. Do not publish the container port, expose the token, or mount the Signal K
configuration tree into the container.

Local PMTiles files stay in the Node process. The plugin validates and registers them, rechecks path
containment when serving, and supports strong ETags and HTTP byte ranges. The egress container handles
only allowlisted tile, vector-style, glyph, sprite, and reverse-geocoding requests.

The runtime image must remain small and must not add GDAL, GEOS, PROJ, SpatiaLite, or similar heavy
native libraries.

## Project invariants

- Keep stored configuration and calculations in SI units. Convert only at display boundaries.
- The cache cap is the physical tile-byte ceiling. Saved-region tiles are pinned, and unpinned scroll
  tiles are the only eviction candidates.
- The saved-regions budget limits pinned bytes. Its position-warm slice is 10 percent, capped at
  64 MiB.
- Cache writes preserve at least 256 MiB of filesystem headroom and degrade without failing tile
  delivery when that reserve would be consumed.
- Durable JSON state uses atomic replacement. Do not replace it with direct writes.
- Management routes use the shared admin gate and fail closed when Signal K cannot provide a security
  strategy.
- Local chart directories must remain inside the Signal K configuration directory. External cache
  paths must be absolute.
- Optional providers and update services must detect absence, degrade cleanly, and explain the missing
  capability.
- Any change under `container/` requires a plugin version bump because the container image tag is
  pinned to the plugin version.

## Layout

- `src/charts/`: PMTiles discovery, metadata, registry, serving support, and overrides
- `src/http/`: public proxy routes and admin-gated management routes
- `src/panel/`: federated React configuration panel, its domain hooks, and the slider-plus-number
  cache cap control; the panel shell, save bar, fields, table, text, and themes come from
  `signalk-nearlcrews-ui`, pinned exactly and verified by its `snui-check-consumer` in the panel build
- `src/plugin/`: Signal K lifecycle and container-manager integration
- `src/runtime/`: persistent state, cache client, position warming, and runtime helpers
- `container/tilecache/`: SQLite cache, upstream fetcher, styles, warm jobs, health, and HTTP routes
- `test/`: Node plugin and panel-support tests
- `tests/browser/`: the Playwright panel spec, run against the production remote
- `docs/OPERATIONS.md`: operational state, recovery, storage, and diagnostics
- `docs/API.md`: maintained plugin HTTP API
- `docs/superpowers/`: historical design records plus the maintained publish runbook

## Required verification

Run the Node and panel gates from the repository root:

```bash
npm run typecheck
npm run lint
npm run deadcode
npm run test:coverage
npm run test:browser:cross
npm run build
npm run check:package
npm run licenses:rust:check
npm audit
```

Run only one browser suite at a time in a checkout. `pretest:browser:cross` rebuilds the panel, and
the clean step removes `public/` while a suite already running is still serving it, which fails that
run at fixture load with an error naming neither cause. The fixture port is this repository's alone
and the suite never reuses a server it did not start, so a second run fails on the port instead of
quietly testing another repository's panel.

Run the Rust gates from `container/`:

```bash
cargo fmt --check
cargo test --locked --workspace --all-features
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo build --locked --release --bin tilecache --all-features
cargo audit --file Cargo.lock
```

The panel build ends with the shared UI package's `snui-check-consumer`, which asserts the exact pin
against the installed version, the bundled version stamp, the host share map, and the gzip size
recorded in `scripts/panel-size-baseline.json`. When a deliberate change grows the remote past the
recorded allowance, re-measure and update `gzipBytes` in the same change rather than raising the
percentage. The Node test suite and the browser spec load the package directly through its `default`
export condition, which needs Node 22.12 or newer; `devEngines` already requires that.

Check panel layout and interaction changes in a real browser using light, dark, and night-red themes.
Update the three App Store screenshots after material visual changes.

Do not edit `dist/` or `public/` manually. They are regenerated by the build. The package-content
check rejects stale retired modules.

## Release rule

Publishing to npm and creating a version tag require explicit final owner approval. Follow the
[publish runbook](docs/superpowers/2026-06-30-publish-runbook.md). The matching versioned container
image must be public and pullable before the GitHub release triggers npm publication.

## Shared skills

Domain expertise for this repository lives in the shared skills installed for both Codex and Claude Code from `~/src/nearlcrews-agent-toolkit` (Claude Code: `/skill-name`; Codex: `$skill-name`; both hosts also select them from their descriptions). Load these before working here:

- `signalk-development`: Signal K plugin and webapp lifecycle, server APIs, deltas, route security, package metadata, App Store, registry score, plugin CI, and release readiness.
- `standardize-project-toolchain`: toolchain audits, lint, type, test, and CI alignment, and Node or TypeScript floor decisions.
- `svelte-maplibre-stack`: its PMTiles section, which also covers the server-side PMTiles usage here.

To delegate, spawn a general-purpose subagent and tell it which of these to load; there are no per-host agent definitions.
