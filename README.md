# Chart Locker

[![npm version](https://img.shields.io/npm/v/signalk-chart-locker.svg)](https://www.npmjs.com/package/signalk-chart-locker)
[![npm downloads](https://img.shields.io/npm/dm/signalk-chart-locker.svg)](https://www.npmjs.com/package/signalk-chart-locker)
[![CI](https://github.com/NearlCrews/signalk-chart-locker/actions/workflows/ci.yml/badge.svg)](https://github.com/NearlCrews/signalk-chart-locker/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/NearlCrews/signalk-chart-locker/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.3-brightgreen.svg)](https://nodejs.org)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/nearlcrews)

A Signal K plugin that runs a Rust container alongside the server to host a shared tile cache
and local PMTiles chart serving.

> The cached tiles and local chart files are advisory. They are not certified for
> safety-of-life navigation: always cross-check against official charts and your primary
> instruments.

## What's new in 0.1.1

Housekeeping and hardening across the plugin and the tilecache container. The egress SSRF guard now
covers the whole `0.0.0.0/8` block and IPv4-compatible IPv6 addresses, the basemap style no longer
serves an off-allowlist upstream to the browser, and a downloaded region and the pinned basemap
glyphs and sprite keep their offline pin across a live revalidation. The configuration panel gains a
live freshness note that keeps advancing during a status-poll outage, and several a11y and caching
refinements land alongside a round of internal deduplication.

See the [changelog](CHANGELOG.md#v011) for the full list.

## What it does

Chart Locker is a Signal K server plugin. It manages a container (via the
[signalk-container](https://github.com/dirkwa/signalk-container) plugin) that runs a Rust service
alongside the server. That service handles workloads the Node.js plugin process cannot: a shared
tile cache that every device on the boat reads from and local `.pmtiles` chart serving with proper
HTTP caching semantics.

The plugin side is thin by design. It resolves the `signalk-container` manager, starts the
tilecache container, and exposes the regions and chart-management HTTP routes. All tile-cache
compute lives in the container.

When Chart Locker is absent, the Binnacle chartplotter falls back to direct upstream sources for
tiles. A standalone install of Binnacle is unaffected.

## Features

- **Shared boat-wide tile cache.** Every raster overlay, the vector basemap, and its glyphs are
  fetched and cached through the Signal K server. Every device on the boat reads from the same
  cache, the same tile is never fetched more than once, and the overlays keep rendering offline
  at sea.
- **Saved regions.** Draw a box in the Binnacle chartplotter and download the raster overlays
  covering it into the shared cache before leaving internet coverage. Each region is named
  automatically by a reverse geocode, saved durably, and can be re-downloaded or deleted. A live
  byte estimate is re-validated on the server against the saved-regions budget before the download
  starts, so an over-budget region is refused. The region tiles are pinned and never evicted, and a
  region never stays stuck downloading.
- **Auto-cache around the boat.** An optional throttled fill keeps a small tile radius warm around
  the vessel as it travels outside the saved regions, always LRU-bounded so it never displaces
  the pinned coverage.
- **Local PMTiles chart provider.** Drop `.pmtiles` archives in the charts folder and the
  companion discovers, validates, and registers them without a plugin restart. Each archive is
  served with a strong ETag and HTTP Range support so the browser cache works. A chart-management
  panel in the Binnacle chartplotter lists the detected archives. Defers gracefully to
  `signalk-pmtiles-plugin` when that plugin is enabled.

## Requirements

- Signal K server 2.x.
- Node.js >= 20.3.
- [signalk-container](https://www.npmjs.com/package/signalk-container) >= 1.20.0, installed and
  running. The companion delegates all container lifecycle to it.
- A container runtime (Podman or Docker) accessible to the Signal K server process.
- The [Binnacle Chartplotter](https://www.npmjs.com/package/signalk-binnacle) for the regions
  and chart-management panels.

## Installation

**From the App Store (recommended).** In the Signal K admin UI, open Apps and Plugins, then
Store, search for Chart Locker, and install. Restart the server when prompted.

**With npm.** Install into the server's home directory and restart Signal K:

```bash
cd ~/.signalk
npm install signalk-chart-locker
```

## Configuration

After installation, enable the plugin in the Signal K plugin configuration panel. The companion
starts the tilecache container automatically when Signal K restarts. No further configuration is
required for the tile cache or the PMTiles provider.

**Tile cache capacity.** The plugin settings expose a slider for the cache size cap that moves in
4 GiB steps, from 4 up to 32 GiB. The default is set to about 80 percent of the free space on the
Signal K data directory at the time the settings load, floored to the nearest 4 GiB to leave
headroom and capped at 32 GiB, and the panel warns when the cap exceeds the detected free space. A
second GiB control sets the
saved-regions budget, a ceiling on how much the pinned region tiles may total; leave it at 0 to
reserve half the cap. That budget is not space taken from the scroll cache until a region is
actually saved: the on-demand scroll cache uses the whole cap until then. A region download pins
its tiles and evicts only unpinned scroll tiles to make room, never a pinned tile, and the scroll
cache is evicted least-recently-used when the cap is reached.

**PMTiles charts.** Place `.pmtiles` files in the server's charts folder (the same folder
`signalk-pmtiles-plugin` uses). The companion detects and registers them automatically. If
`signalk-pmtiles-plugin` is already enabled and serving that folder, the companion surfaces a
clear status and defers to it.

## Development

This project targets Node.js 20.3 or newer. The Rust container is a Cargo workspace under
`container/`.

```bash
git clone https://github.com/NearlCrews/signalk-chart-locker.git
cd signalk-chart-locker
npm install
npm run typecheck   # TypeScript type-check
npm run lint        # ESLint
npm test            # node --test unit tests
npm run build       # compile TypeScript to dist/
```

Rust (Cargo workspace):

```bash
cd container
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release --bin tilecache
```

## License

MIT. See [LICENSE](LICENSE) for the full text. The software is provided "AS IS", without warranty
of any kind.

## Acknowledgments

Chart Locker is written and maintained by [Nearl Crews](https://github.com/NearlCrews). It
relies on:

- [Signal K Project](https://signalk.org/) for the open marine data standard.
- [signalk-container](https://github.com/dirkwa/signalk-container) for container lifecycle
  management.

Chart Locker pairs with the
[Binnacle Chartplotter](https://www.npmjs.com/package/signalk-binnacle).

## Support

Find this project useful? You can support its continued development by
[buying me a coffee](https://www.buymeacoffee.com/nearlcrews).

- [Report a bug](https://github.com/NearlCrews/signalk-chart-locker/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/NearlCrews/signalk-chart-locker/issues/new?template=feature_request.yml)
- [Security issues](.github/SECURITY.md)
