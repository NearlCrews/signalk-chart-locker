# Chart Locker

[![npm version](https://img.shields.io/npm/v/signalk-chart-locker.svg)](https://www.npmjs.com/package/signalk-chart-locker)
[![npm downloads](https://img.shields.io/npm/dm/signalk-chart-locker.svg)](https://www.npmjs.com/package/signalk-chart-locker)
[![CI](https://github.com/NearlCrews/signalk-chart-locker/actions/workflows/ci.yml/badge.svg)](https://github.com/NearlCrews/signalk-chart-locker/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT%20%2F%20Apache--2.0-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/nearlcrews)

A Signal K plugin that runs a Rust container alongside the server to host a shared tile cache
and local PMTiles chart serving.

> The cached tiles and local chart files are advisory. They are not certified for
> safety-of-life navigation: always cross-check against official charts and your primary
> instruments.

## What's new in 0.6.1

Version 0.6.1 upgrades `signalk-chart-sources` to 0.4.0 and applies its stricter source structure,
URL, template, host, WMS, ArcGIS, and zero-longitude-span validation at the Rust tile-cache boundary.

The release also aligns local, CI, release, and container builds on Rust 1.97.0, refreshes locked
Rust networking dependencies and their license inventory, and smoke-tests the complete tile-cache
image when pull requests change its build inputs.

See the [0.6.1 changelog](CHANGELOG.md#v061) for the full list.

## What it does

Chart Locker is a Signal K server plugin. It manages a container (via the
[signalk-container](https://github.com/dirkwa/signalk-container) plugin) that runs a Rust service
alongside the server. That service handles the shared tile cache that every device on the boat reads
from. The Node.js plugin discovers and serves local `.pmtiles` charts with proper HTTP caching
semantics, independently of the container runtime.

The plugin side is thin by design. It resolves the `signalk-container` manager, starts the
tilecache container, and exposes the regions and chart-management HTTP routes. All tile-cache
compute lives in the container.

The tilecache container also reports its update state in the `signalk-container` Container Manager
panel: an "up to date" badge, a "checked N ago" timestamp, and a "Check now" button. The check
reads the GitHub releases of this repository, and because the container image tag is pinned to the
plugin version, "update available" means a newer Chart Locker release exists: update the plugin in
the App Store and the container is recreated on the new tag. Offline at sea the check reports the
last cached result and never fabricates an update. The badge needs `signalk-container` 1.20.2 or
newer; older versions skip the registration and everything else works unchanged.

When Chart Locker is absent, the Binnacle chartplotter falls back to direct upstream sources for
tiles. A standalone install of Binnacle is unaffected.

## Features

- **Shared boat-wide tile cache.** Every raster overlay, the vector basemap, and its glyphs are
  fetched and cached through the Signal K server. Every device on the boat reads from the same
  cache, the same tile is never fetched more than once, and the overlays keep rendering offline
  at sea.
- **Saved regions.** Draw a box in the Binnacle chartplotter and download the raster overlays
  covering it into the shared cache before leaving internet coverage. Each region is named
  automatically by an optional reverse geocode, saved durably, and can be re-downloaded or deleted.
  A live byte estimate is re-validated on the server against the saved-regions budget before the
  download starts, so an over-budget region is refused. The region tiles are pinned and never
  evicted, and a region never stays stuck downloading.
- **Auto-cache around the boat.** An optional throttled fill keeps a small tile radius warm around
  the vessel as it travels outside the saved regions, always LRU-bounded so it never displaces
  the pinned coverage. A radius that crosses the antimeridian is split into two bounded boxes and
  completed as one warm job.
- **Local PMTiles chart provider.** Drop `.pmtiles` archives in the charts folder and the
  plugin discovers, validates, and registers them without a plugin restart. Each archive is
  served with a strong ETag and HTTP Range support so the browser cache works. A chart-management
  panel in the Binnacle chartplotter lists the detected archives. Defers gracefully to
  `signalk-pmtiles-plugin` when that plugin is enabled.
- **Operational configuration panel.** Inspect cache usage, filesystem headroom, source health,
  diagnostics, and chart discovery without leaving the Signal K admin UI. Change scroll retention,
  clear only unpinned scroll tiles, refresh live state, and request a chart rescan from the same panel.
  The panel uses the accessible, theme-aware
  [`signalk-nearlcrews-ui`](https://github.com/NearlCrews/signalk-nearlcrews-ui) primitives and shares
  its Auto, Light, Dark, and Night preference with other NearlCrews plugin panels.

## Requirements

- Signal K server >= 2.24.0, which provides the React 19.2 Admin host required by the configuration
  panel.
- Node.js >= 22.
- A Signal K Admin browser or embedded WebView with native CSS `@scope`: Chromium or Edge 118,
  Firefox 146, or Safari 17.4 and newer.
- [signalk-container](https://www.npmjs.com/package/signalk-container) >= 1.20.0 and a container
  runtime (Podman or Docker) accessible to Signal K are required for tile caching, saved-region
  downloads, position warming, and reverse geocoding. Local PMTiles discovery and serving continue
  without them. Version 1.20.2 or newer is recommended for the Container Manager update badge.
- [Binnacle Chartplotter](https://www.npmjs.com/package/signalk-binnacle) 0.15.4 or newer for reliable
  saved-region create and re-download recovery, plus the regions and chart-management panels.
  Binnacle 0.15.3 and older do not accept Chart Locker's recovery-pending response.

On secured Signal K servers that expose scoped plugin routers, chart tiles, styles, readiness checks,
and PMTiles files are available to authenticated `readonly`, `readwrite`, and administrator users.
Released servers without that router API keep all plugin routes behind their administrator-only
mount. Saving regions, changing cache settings, reverse geocoding, and editing chart metadata always
require an administrator session. Signal K servers with security disabled expose the read routes
without a login.

## Installation

**From the App Store (recommended).** In the Signal K admin UI, open Apps and Plugins, then
Store, search for Chart Locker, and install. Restart the server when prompted.

**With npm.** Install into the server's home directory and restart Signal K:

```bash
cd ~/.signalk
npm install signalk-chart-locker
```

## Configuration

After installation, enable the plugin in the Signal K plugin configuration panel. Chart Locker
starts the tilecache container automatically when Signal K restarts. No further configuration is
required for the tile cache or the PMTiles provider.

**Tile cache capacity.** The cache cap slider moves in 4 GiB steps from 4 through 32 GiB. On a new
configuration, the panel recommends about 80 percent of the free space on the filesystem that will
hold the cache, floored to the nearest 4 GiB and capped at 32 GiB. When an external cache path is
configured and available, its filesystem is measured. If it is unavailable, the panel clearly
reports that free-space guidance has fallen back to the Signal K data filesystem.

The saved-regions budget is a ceiling on pinned region tiles. Leave it at 0 to use half the cache
cap. It must not exceed the cache cap. This budget does not remove space from the scroll cache until
a region is saved. A region download pins its tiles and evicts only unpinned scroll tiles to make
room. Pinned tiles are never evicted by scroll-cache pressure.

Cache-cap reductions are applied transactionally. If the requested cap is below the bytes that
saved coverage currently pins, the tile cache rejects the reduction without publishing partial
settings. The previous container configuration remains active when one exists; a fresh container
whose retained database already exceeds its first requested cap remains unconfigured. Increase the
cap, or delete saved coverage and redownload only the regions that fit, before retrying the lower
value.

The settings panel also provides live cache operations: total, pinned, and scroll usage; remaining
saved-region headroom; actual filesystem free space; per-source usage and upstream health; scroll
retention; and a safe clear action that preserves saved-region tiles. The cache keeps 256 MiB of
filesystem headroom outside its configured cap. Under disk pressure it continues serving fetched
tiles without writing them and reports the degraded state in the panel.

**Scroll retention.** Set retention from 0 through 365 days. A value of 0 disables age-based
removal. The clear action removes every unpinned scroll tile and preserves saved-region and other
pinned tiles. Retention changes are persisted even when the container is temporarily unavailable and
are pushed again on the next start.

**External cache drive.** The Advanced section accepts an absolute host path for a USB SSD, NVMe
drive, or other cache filesystem. A relative path is rejected. Create the directory first, and make
sure a removable drive is mounted before Signal K starts. With the default rootless Podman mapping,
grant the Signal K host user read and write access. With Docker or rootful Podman configurations that
retain container IDs, grant UID and GID 65532 access. If `disableUserNamespaceRemap` is enabled,
verify the effective host ownership used by the runtime and grant that identity access. Chart Locker
treats the path as required and refuses to start the tilecache instead of silently filling the Signal
K data filesystem when the path is absent. The PMTiles provider remains available, and the plugin
error identifies the missing path.

**Reverse geocoding.** Region auto-naming is enabled by default and can be disabled in Advanced.
When enabled, starting a region download may send the box-center latitude and longitude, rounded to
five decimal places, to OpenStreetMap Nominatim. The container applies one application-wide request
per second, keeps up to 256 successful lookups in memory for 24 hours, and never sends a request while
the control is disabled. The cache is cleared when the container restarts. A disabled or unavailable
geocoder does not block a region download; the chartplotter uses an editable coordinate-derived name.

**PMTiles charts.** Place `.pmtiles` files in the server's charts folder (the same folder
`signalk-pmtiles-plugin` uses). Chart Locker detects and registers them automatically. If
`signalk-pmtiles-plugin` is already enabled and serving that folder, Chart Locker surfaces a
clear status and defers to it.

The panel reports valid and invalid archives, their latest scan time, and each validation error. Use
the Rescan charts action after copying files when an operating-system watch event was delayed.

The charts path must be relative to the Signal K configuration directory and cannot escape it with
`..`. The optional image tag in Advanced must be a valid OCI tag. Invalid settings are shown next to
the configuration and rejected again by the plugin before any container work starts.

Saving cache limits, chart discovery settings, or container settings can reapply configuration or
recreate the tile-cache container. The panel summarizes that restart impact before saving.

## Reliability and recovery

Chart Locker probes the tilecache through the host-side address that Signal K uses. After three
consecutive failures, it runs the healthcheck inside the container. If the container is healthy but
the published port is unreachable, Chart Locker restarts the container, resolves the port again, and
restores its source and budget configuration before reporting recovery. Failed recovery attempts are
rate-limited for five minutes and remain visible in the plugin status.
The health payload also carries configuration readiness, so an automatic Docker or Podman restart
that leaves the process healthy but clears its in-memory sources triggers the same configuration
restore without another container restart.

- State files are written through a flushed temporary file and atomically renamed, preventing a
  partial JSON document after power loss.
- A database-aware health check verifies SQLite before the container reports healthy. The plugin
  separately reports whether the source and budget configuration push has completed.
- If the disposable cache database is recreated, saved regions whose pinned bytes disappeared are
  marked `needs-redownload` instead of remaining falsely ready.
- A rejected or failed region replacement keeps the prior usable pins. Accepted warm starts whose
  response is lost are recovered by region ID, while a confirmed missing job is reconciled to an
  error instead of leaving the region stuck downloading.
- Position-warm, saved-region, chart override, and direct plugin configuration inputs are validated
  at their server boundaries.

See [Operations](docs/OPERATIONS.md) for status interpretation, diagnostics, recovery procedures,
and structured log events. See [HTTP API](docs/API.md) for the plugin routes and validation limits.

## Configuration panel

| Light | Dark | Night red |
| ----- | ---- | --------- |
| ![Light configuration panel](assets/screenshots/config-panel.png) | ![Dark configuration panel](assets/screenshots/config-panel-dark.png) | ![Night-red configuration panel](assets/screenshots/config-panel-night.png) |

## Development

This project targets Node.js 22 or newer. The Rust container is a Cargo workspace under
`container/`.

```bash
git clone https://github.com/NearlCrews/signalk-chart-locker.git
cd signalk-chart-locker
npm ci
npx --no-install playwright install --with-deps chromium firefox webkit # one-time browser install
npm run typecheck   # TypeScript type-check
npm run lint        # ESLint
npm test            # node --test unit tests
npm run test:browser:cross # production panel remote in Chromium, Firefox, WebKit, and mobile Chromium
npm run build       # clean and compile dist/, then build the panel remote
npm run check:package
npm run licenses:rust:check # verify locked Rust runtime attribution
npm audit           # runtime and build-time dependencies
```

Rust (Cargo workspace):

```bash
cd container
cargo test --locked --workspace --all-features
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo build --locked --release --bin tilecache --all-features
cargo install cargo-audit --version 0.22.2 --locked
cargo audit --file Cargo.lock
cd ..
TILECACHE_BIN="$PWD/container/target/release/tilecache" npm run test:node-rust-contract
```

Before a release, also verify the panel in a real browser and follow the
[publish runbook](docs/superpowers/2026-06-30-publish-runbook.md). Publishing the npm package or
creating the version tag requires explicit owner approval.

## License

The Node.js plugin is MIT licensed. The Rust tile-cache workspace is Apache-2.0 licensed. See
[LICENSE](LICENSE), [LICENSE-APACHE](LICENSE-APACHE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Locked Rust runtime dependency licenses are
recorded in [RUST_THIRD_PARTY_LICENSES.md](RUST_THIRD_PARTY_LICENSES.md). The software is provided
"AS IS", without warranty of any kind.

## Acknowledgments

Chart Locker is written and maintained by [Nearl Crews](https://github.com/NearlCrews). It
relies on:

- [Signal K Project](https://signalk.org/) for the open marine data standard.
- [signalk-container](https://github.com/dirkwa/signalk-container) for container lifecycle
  management.
- [signalk-nearlcrews-ui](https://github.com/NearlCrews/signalk-nearlcrews-ui) for the shared
  configuration-panel design system.

Chart Locker pairs with the
[Binnacle Chartplotter](https://www.npmjs.com/package/signalk-binnacle).

## Support

Find this project useful? You can support its continued development by
[buying me a coffee](https://www.buymeacoffee.com/nearlcrews).

- [Report a bug](https://github.com/NearlCrews/signalk-chart-locker/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/NearlCrews/signalk-chart-locker/issues/new?template=feature_request.yml)
- [Security issues](.github/SECURITY.md)
