# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<a id="v040"></a>

## [0.4.0] - 2026-07-07

Dependency currency and hardening pass for the tilecache container and the Node plugin build
tooling. No configuration or data-model changes.

### Changed

- Updated the tilecache container's Rust dependencies to their current major versions: axum,
  reqwest, rusqlite, and sha2. The egress fetch path now uses reqwest's current TLS defaults (the
  platform certificate verifier backed by the runtime's system CA bundle) in place of the prior
  pinned root set.
- Updated the plugin's build tooling to its current major versions: Babel and `@types/node`.

### Added

- A regression test proving the egress SSRF guard still rejects a loopback-resolving host through
  the real request path, not just the resolver in isolation.

<a id="v031"></a>

## [0.3.1] - 2026-07-06

The tilecache container now reports its update state in the Container Manager panel. No
configuration or data-model changes.

### Added

- Update checks for the tilecache container in the Container Manager panel of the Signal K admin
  UI: an "up to date" badge, a "checked N ago" timestamp, and a "Check now" button for
  `sk-chart-locker-tilecache`, like the other managed containers. The plugin registers the
  container with the signalk-container update service on start, checks the GitHub releases of this
  repository, runs one check right away so the badge populates without waiting for the daily
  scheduled check, and unregisters on stop. Because the image tag is pinned to the plugin version,
  "up to date" means the newest Chart Locker release is running; when a newer release exists,
  updating the plugin in the App Store recreates the container on the new tag. Offline at sea the
  check returns the last cached result marked offline and never fabricates an update. The badge
  needs signalk-container 1.20.2 or newer; older versions skip the registration and everything
  else works unchanged.

<a id="v030"></a>

## [0.3.0] - 2026-07-05

The tilecache now rides out slow chart upstreams instead of leaving blank areas on the
chartplotter (issue #3, observed with NOAA MaritimeChartService answering GetMap in about
65 seconds per tile). No configuration or data-model changes.

### Added

- Per-source adaptive upstream timeout in the tilecache. The egress timeout backs off from 20 to
  40 to 80 seconds while a source keeps timing out, stays escalated until the source has been
  quiet for five minutes, and then recovers to the base. A timed-out fetch is retried once at the
  escalated timeout. A timeout is never negative-cached; only a real upstream 404 or 204 is.
- Upstream health on `GET /cache/stats`: a new `upstream` object reports, per source, whether it
  is currently slow, the adaptive timeout in seconds, and the time of the last timeout, so a
  client can show a degraded badge instead of blank tiles. The plugin's `/api/cache/stats` passes
  it through unchanged.

### Fixed

- A tile fetch now survives the browser or the plugin proxy giving up. The fill runs detached in
  the container, completes, and stores the tile, so areas blanked by a degraded upstream self-heal
  as the map is panned. Previously a disconnect cancelled the upstream fetch mid-flight and the
  cache never filled from scroll traffic on a slow upstream.
- A source marked slow serves its stale cached tiles immediately and revalidates them in the
  background, instead of blocking each tile request on a multi-second upstream round trip.
- Concurrent revalidations of the same stale tile now coalesce through the single-flight guard
  instead of each fetching the upstream.

<a id="v020"></a>

## [0.2.0] - 2026-07-04

Hardening, performance, and internal cleanup across the plugin and the tilecache container, plus a
shared-library uptake. No configuration or data-model changes.

### Security

- The egress SSRF guard now also rejects the RFC 8215 local-use NAT64 prefix `64:ff9b:1::/48`.
- A basemap style source whose inline tiles or TileJSON url reference a host off the style's allowlist
  is now decided once at learn time and stripped from the served style, closing a gap where an
  off-allowlist inline-tiles source was rewritten to a proxy path instead of stripped.

### Performance

- The `/cache/stats` real-region pinned-bytes figure is memoized and recomputed only after a pin, unpin,
  or region delete, so polling the cache-info panel no longer runs a per-tile scan each time.
- Position warm reads the saved-regions file through a filesystem watcher with a throttled mtime
  self-heal, so the per-fix path does no I/O between writes.

### Changed

- Adopt `signalk-chart-sources` 0.2.0 and use its exported `Bbox` type for the geographic and tile
  bounding boxes the plugin previously spelled out as a four-number tuple.
- The panel's polling and one-shot fetches share one abortable-fetch hook.
- Internal cleanup in the container: the glyph, sprite, and vector-tile routes share one cache-first
  single-flight helper; the cache methods take a single `TileKey` so the tile coordinates travel
  together and cannot be transposed; and the negative-cache row shape lives in one constructor.

<a id="v011"></a>

## [0.1.1] - 2026-07-04

Housekeeping and hardening across the plugin and the tilecache container.

### Security

- The egress SSRF guard now rejects the whole `0.0.0.0/8` "this network" block, not only `0.0.0.0`, so
  a literal such as `0.1.2.3` (which Linux routes to the local host) can no longer reach loopback
  through the proxy. IPv4-compatible IPv6 addresses (for example `::127.0.0.1`) are decoded and checked
  the same way.
- The basemap glyph range parameter is fully validated and canonicalized before it reaches the
  upstream URL, so a crafted range can neither mis-key the cache nor smuggle an arbitrary path
  upstream.
- A basemap style source whose tiles or TileJSON reference a host off the style's allowlist is stripped
  from the served style rather than passed through, so the browser can no longer be told to fetch that
  host directly and bypass the cache and the allowlist.
- The reserved internal cache regions (position warm and basemap assets) can no longer be deleted
  through the region API.

### Fixed

- A downloaded region, and the pinned basemap glyph and sprite set, no longer silently lose their
  offline pin the first time a tile is viewed live after it goes stale. Revalidating a pinned tile
  keeps it pinned and keeps the pinned-byte accounting exact.
- A missing basemap vector tile now returns 404 and is negative-cached, instead of being reported as a
  502 gateway error and refetched on every request.
- A basemap style source that fails to learn is recorded as a region error and logged, so a region
  whose basemap never warmed no longer reports as fully downloaded.
- Position warm reads the saved-regions file through a modification-time cache instead of reading and
  parsing it on every `navigation.position` fix, so a boat under way no longer does a synchronous disk
  read per position update.
- A per-chart override saved through the management route now merges its fields instead of replacing
  the stored override, so setting one field no longer wipes the others.

### Config panel

- The status bar's "checked N ago" note keeps advancing during a status-poll outage instead of
  freezing, so a stalled readout is visible.
- The footer no longer shows "Save to enable the plugin" alongside the "Saved" confirmation after the
  first save.
- A stored cache-cap of null or empty now falls back to the default instead of clamping to the minimum.
- Keyboard focus rings are now visible on the theme segmented control and the Advanced disclosure, and
  placeholder text is themed for dark and night mode.
- The free-space warning announces politely rather than assertively, and the cache-cap number box has a
  distinct accessible name from its slider.

### Changed

- Negative-cache, revalidation, and last-access writes in the container run off the async reactor on
  the blocking pool, matching the existing tile-store path.
- The saved-region warm shares the source and the region id through a per-tile reference count instead
  of cloning them for every enumerated tile.
- The style route relays `cache-control` and `last-modified` so basemap styles get the same browser
  caching as every other proxied path.
- The plugin mount path, the plugin version, and the whole-Unix-seconds timestamp are each defined once
  and shared, replacing four copies of the mount path and three copies of the timestamp. The container
  is now attributed with the plugin version.
- Removed a dead container job field, the vestigial `fetch_bytes` helper, and several duplicated header,
  timestamp, and type-cast expressions in the plugin.

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
- **Resilience and hardening.** Every request from the plugin to the container is bounded by a
  timeout, so a slow or unreachable container fails fast instead of hanging a request, the
  position-warm loop, a health probe, or plugin startup. Inside the container, the cache-write and
  eviction and the region delete run off the request path, so a large warm or eviction cannot stall
  live tile reads; a warm is gated on its true tile total; a corrupt cache file self-heals by
  recreating rather than crash-looping; and the egress SSRF guard also rejects the IPv6 6to4 and
  NAT64 transition ranges.
