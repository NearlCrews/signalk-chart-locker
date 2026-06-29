# Binnacle Companion

[![npm version](https://img.shields.io/npm/v/signalk-binnacle-companion.svg)](https://www.npmjs.com/package/signalk-binnacle-companion)
[![npm downloads](https://img.shields.io/npm/dm/signalk-binnacle-companion.svg)](https://www.npmjs.com/package/signalk-binnacle-companion)
[![CI](https://github.com/NearlCrews/signalk-binnacle-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/NearlCrews/signalk-binnacle-companion/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/NearlCrews/signalk-binnacle-companion/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.3-brightgreen.svg)](https://nodejs.org)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/nearlcrews)

A Signal K plugin that runs a polyglot container alongside the server to host tile caching, local chart serving, and on-water routing compute that a JavaScript plugin cannot.

> The routing engine and the offline chart data are advisory. They are not certified for
> safety-of-life navigation: always cross-check against official charts and your primary
> instruments.

## What's new in 0.1.0

The initial release, with shared boat-wide tile caching, offline chart serving, and the on-water routing container:

- **Tile cache prewarm.** Draw a cruising box in the Binnacle chartplotter and fill the shared
  boat-wide cache before departure. A live byte estimate is gated against the cache capacity, the
  prewarmed box is pinned and never evicted, and writes are bounded for microSD longevity.
- **Off-plan position-warm.** An optional throttled fill keeps a small tile radius warm around the
  vessel when it travels outside the prewarmed box, always LRU-bounded so it never displaces the
  pinned coverage.
- **Local PMTiles chart provider.** Drop `.pmtiles` archives in the charts folder and the companion
  discovers, validates, and registers them without a plugin restart. Each archive is served with a
  strong ETag and HTTP Range support so the browser cache works. A chart-management panel in the
  Binnacle chartplotter lists the detected archives.
- **On-water routing container.** A Rust router container handles channel-routing requests from
  signalk-crows-nest when the companion is present, keeping the heavy geometry off the Signal K
  server process.

See the [changelog](CHANGELOG.md#v010) for the full list.

## What it does

Binnacle Companion is a Signal K server plugin. It manages a container (via the
[signalk-container](https://github.com/dirkwa/signalk-container) plugin) that runs a Rust service
alongside the server. That service handles workloads the Node.js plugin process cannot: a shared
tile cache that every device on the boat reads from, local `.pmtiles` chart serving with proper HTTP
caching semantics, and a channel-routing engine backed by offline NOAA ENC geodata.

The plugin side is thin by design. It resolves the `signalk-container` manager, starts the
container, and exposes the in-process bridge that signalk-crows-nest calls for on-water routing. All
heavy compute lives in the container.

When the companion is absent, the Binnacle chartplotter falls back to direct upstream sources for
tiles, and signalk-crows-nest falls back to its built-in router. A standalone install of either is
unaffected.

## Features

- **Shared boat-wide tile cache.** Every raster overlay, the vector basemap, and its glyphs are
  fetched and cached through the Signal K server. Every device on the boat reads from the same cache,
  the same tile is never fetched more than once, and the overlays keep rendering offline at sea.
- **Tile cache prewarm.** Fill the cache for a drawn cruising box before leaving internet coverage,
  with a live byte estimate and a pinned, never-evicted result.
- **Off-plan position-warm.** Keep a small radius of tiles around the vessel warm when it travels
  outside the prewarmed box, always bounded by an LRU policy.
- **Local PMTiles chart provider.** Discover, validate, and serve `.pmtiles` archives with strong
  ETag and HTTP Range support, without a plugin restart on new charts. Defers gracefully to
  `signalk-pmtiles-plugin` when that plugin is enabled.
- **On-water routing.** A Rust engine hand-ported from the signalk-crows-nest channel router, backed
  by an offline OGC GeoPackage built from NOAA ENC S-57 cells, answers routing requests with
  charted-water awareness. Until a local geodata store is loaded, every request declines honestly as
  `no-coverage`.

## Requirements

- Signal K server 2.x.
- Node.js >= 20.3.
- [signalk-container](https://www.npmjs.com/package/signalk-container) >= 1.20.0, installed and
  running. The companion delegates all container lifecycle to it.
- A container runtime (Podman or Docker) accessible to the Signal K server process.
- The [Binnacle Chartplotter](https://www.npmjs.com/package/signalk-binnacle) for the prewarm and
  chart-management panels.
- [signalk-crows-nest](https://www.npmjs.com/package/signalk-crows-nest) for on-water routing.

## Installation

**From the App Store (recommended).** In the Signal K admin UI, open Apps and Plugins, then Store,
search for Binnacle Companion, and install. Restart the server when prompted.

**With npm.** Install into the server's home directory and restart Signal K:

```bash
cd ~/.signalk
npm install signalk-binnacle-companion
```

## Configuration

After installation, enable the plugin in the Signal K plugin configuration panel. The companion
starts the container automatically when Signal K restarts. No further configuration is required for
the tile cache or the PMTiles provider.

**Tile cache capacity.** Set the maximum cache size (in megabytes) in the plugin settings. The
default is sized conservatively for a microSD card. The prewarmed box is pinned within this budget;
position-warm tiles fill the remainder under LRU eviction.

**PMTiles charts.** Place `.pmtiles` files in the server's charts folder (the same folder
`signalk-pmtiles-plugin` uses). The companion detects and registers them automatically. If
`signalk-pmtiles-plugin` is already enabled and serving that folder, the companion surfaces a clear
status and defers to it.

**On-water routing geodata.** Routing requires a local GeoPackage store built from NOAA ENC S-57
cells. See `container/prep/` in the source repository for the preparation pipeline. Set
`BINNACLE_REGION_STORE` to the path of the built store in the container environment.

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
cargo build --release --bin router
```

## License

MIT. See [LICENSE](LICENSE) for the full text. The software is provided "AS IS", without warranty
of any kind. The routing engine and the offline chart data are not certified for navigation: treat
all on-screen information as advisory and always carry independent means of position-fixing.

## Acknowledgments

Binnacle Companion is written and maintained by [Nearl Crews](https://github.com/NearlCrews). It
relies on:

- [Signal K Project](https://signalk.org/) for the open marine data standard.
- [signalk-container](https://github.com/dirkwa/signalk-container) for container lifecycle
  management.
- [NOAA](https://www.noaa.gov/) for the ENC S-57 chart cells the prep pipeline reads.
- [Marine Regions (VLIZ)](https://www.vliz.be/) for the EEZ boundary data used in border-aware
  routing.

Binnacle Companion pairs with the
[Binnacle Chartplotter](https://www.npmjs.com/package/signalk-binnacle) and
[signalk-crows-nest](https://www.npmjs.com/package/signalk-crows-nest).

## Support

Find this project useful? You can support its continued development by
[buying me a coffee](https://www.buymeacoffee.com/nearlcrews).

- [Report a bug](https://github.com/NearlCrews/signalk-binnacle-companion/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/NearlCrews/signalk-binnacle-companion/issues/new?template=feature_request.yml)
- [Security issues](.github/SECURITY.md)
