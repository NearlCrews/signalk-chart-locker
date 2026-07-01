# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<a id="v010"></a>

## [0.1.0] - 2026-06-30

The first public release. Chart Locker is a Signal K plugin that runs an egress-isolated Rust
container alongside the server to host a boat-wide tile cache and local PMTiles chart serving. The
plugin process stays thin: it resolves the [signalk-container](https://github.com/dirkwa/signalk-container)
manager, starts the tilecache container, and exposes the regions and chart-management HTTP routes.
All tile-cache compute lives in the container.

### Added

- **Shared boat-wide tile cache.** Raster overlays, the vector basemap, and the basemap glyphs and
  sprite are fetched and cached through the Signal K server. Every device on the boat reads from the
  same cache, the same tile is never fetched twice, and the overlays keep rendering offline at sea.
  The container links only against libc, libm, libgcc, and the loader: no GDAL, GEOS, PROJ, or
  SpatiaLite in the runtime image.
- **Saved regions and region download.** Draw a box in the Binnacle chartplotter, then download the
  overlays covering it into the shared cache before leaving internet coverage. Each region is named
  automatically by a reverse geocode through a guarded `/api/geocode` proxy to OpenStreetMap
  Nominatim, saved durably, and can be re-downloaded or deleted. A live byte estimate is
  re-validated on the server against the saved-regions budget before the download starts, so an
  over-budget region is refused upfront. Region tiles are pinned and never evicted, and a status
  reconcile on every poll plus a startup sweep ensures a region never stays stuck downloading.
- **Basemap in a saved region, fully offline.** The vector basemap is a selectable source when
  saving a region, so a downloaded region renders its base layer offline: geometry, labels, and
  icons. The basemap tiles warm at their native vector maxzoom and overzoom above it, and the common
  glyphs and the sprite warm once globally and every region reuses them.
- **Auto-cache around the boat.** An optional throttled fill keeps a small tile radius warm around
  the vessel as it travels outside the saved regions, always LRU-bounded so it never displaces the
  pinned coverage. It ships enabled with no charts picked, so the panel surfaces it as on and prompts
  the navigator to choose which charts to cache rather than starting a silent download.
- **Cache size cap and scroll-cache management.** The plugin settings size the on-disk cache cap to
  about 80 percent of the free space on the Signal K data directory, presented as a slider that
  moves in 4 GiB steps up to 32 GiB and warns when the cap exceeds the detected free space, with a second GiB
  control for the saved-regions budget. A storage view shows the cache total
  against the cap and a per-source breakdown, sets an age limit in days for the on-demand scroll
  cache, and clears the scroll cache on demand. The age sweep and the clear run in bounded chunks
  and never touch pinned region or position-warm tiles, and writes are bounded for microSD
  longevity.
- **Configuration panel.** The plugin settings render as a custom panel matching the companion
  plugins, with the same design tokens, light, dark, and night themes, a live status line, and a
  sticky save bar. It reads the free space on the data directory to seed the cache cap and to warn
  when the cap exceeds it, and falls back to the generated settings form when the panel cannot load.
- **Local PMTiles chart provider.** Drop `.pmtiles` archives in the server's charts folder and the
  plugin discovers, validates, and registers them without a restart. Each archive is served with a
  strong file-identity ETag and HTTP Range support so the browser cache works. A chart-management
  panel in the Binnacle chartplotter lists the detected archives with a per-chart name and
  description. Defers gracefully to `signalk-pmtiles-plugin` when that plugin is enabled.
