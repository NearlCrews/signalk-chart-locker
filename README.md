# Binnacle Companion

[![npm version](https://img.shields.io/npm/v/signalk-binnacle-companion.svg)](https://www.npmjs.com/package/signalk-binnacle-companion)
[![npm downloads](https://img.shields.io/npm/dm/signalk-binnacle-companion.svg)](https://www.npmjs.com/package/signalk-binnacle-companion)
[![CI](https://github.com/NearlCrews/signalk-binnacle-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/NearlCrews/signalk-binnacle-companion/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/NearlCrews/signalk-binnacle-companion/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.3-brightgreen.svg)](https://nodejs.org)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/nearlcrews)

A Signal K plugin that runs a Rust container alongside the server to host a shared tile cache
and local PMTiles chart serving.

## What's new in 0.2.0

The routing engine and offline geodata pipeline are removed. The companion is now a tile cache
and PMTiles chart provider only. The tilecache container remains; the router container, the
route-on-water bridge, and the geodata prep tool are gone.

See the [changelog](CHANGELOG.md#v020) for the full list.

## What it does

Binnacle Companion is a Signal K server plugin. It manages a container (via the
[signalk-container](https://github.com/dirkwa/signalk-container) plugin) that runs a Rust service
alongside the server. That service handles workloads the Node.js plugin process cannot: a shared
tile cache that every device on the boat reads from and local `.pmtiles` chart serving with proper
HTTP caching semantics.

The plugin side is thin by design. It resolves the `signalk-container` manager, starts the
tilecache container, and exposes the prewarm and chart-management HTTP routes. All tile-cache
compute lives in the container.

When the companion is absent, the Binnacle chartplotter falls back to direct upstream sources for
tiles. A standalone install of Binnacle is unaffected.

## Features

- **Shared boat-wide tile cache.** Every raster overlay, the vector basemap, and its glyphs are
  fetched and cached through the Signal K server. Every device on the boat reads from the same
  cache, the same tile is never fetched more than once, and the overlays keep rendering offline
  at sea.
- **Tile cache prewarm.** Draw a cruising box in the Binnacle chartplotter and fill the shared
  cache before leaving internet coverage. A live byte estimate is gated against the cache
  capacity, the prewarmed box is pinned and never evicted, and writes are bounded for microSD
  longevity.
- **Off-plan position-warm.** An optional throttled fill keeps a small tile radius warm around
  the vessel when it travels outside the prewarmed box, always LRU-bounded so it never displaces
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
- The [Binnacle Chartplotter](https://www.npmjs.com/package/signalk-binnacle) for the prewarm
  and chart-management panels.

## Installation

**From the App Store (recommended).** In the Signal K admin UI, open Apps and Plugins, then
Store, search for Binnacle Companion, and install. Restart the server when prompted.

**With npm.** Install into the server's home directory and restart Signal K:

```bash
cd ~/.signalk
npm install signalk-binnacle-companion
```

## Configuration

After installation, enable the plugin in the Signal K plugin configuration panel. The companion
starts the tilecache container automatically when Signal K restarts. No further configuration is
required for the tile cache or the PMTiles provider.

**Tile cache capacity.** Set the maximum cache size (in megabytes) in the plugin settings. The
default is sized conservatively for a microSD card. The prewarmed box is pinned within this
budget; position-warm tiles fill the remainder under LRU eviction.

**PMTiles charts.** Place `.pmtiles` files in the server's charts folder (the same folder
`signalk-pmtiles-plugin` uses). The companion detects and registers them automatically. If
`signalk-pmtiles-plugin` is already enabled and serving that folder, the companion surfaces a
clear status and defers to it.

## Development

This project targets Node.js 20.3 or newer. The Rust container is a Cargo workspace under
`container/`.

```bash
git clone https://github.com/NearlCrews/signalk-binnacle-companion.git
cd signalk-binnacle-companion
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

Binnacle Companion is written and maintained by [Nearl Crews](https://github.com/NearlCrews). It
relies on:

- [Signal K Project](https://signalk.org/) for the open marine data standard.
- [signalk-container](https://github.com/dirkwa/signalk-container) for container lifecycle
  management.

Binnacle Companion pairs with the
[Binnacle Chartplotter](https://www.npmjs.com/package/signalk-binnacle).

## Support

Find this project useful? You can support its continued development by
[buying me a coffee](https://www.buymeacoffee.com/nearlcrews).

- [Report a bug](https://github.com/NearlCrews/signalk-binnacle-companion/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/NearlCrews/signalk-binnacle-companion/issues/new?template=feature_request.yml)
- [Security issues](.github/SECURITY.md)
