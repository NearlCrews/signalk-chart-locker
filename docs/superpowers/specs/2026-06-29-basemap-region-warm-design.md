# Basemap region-warm design (2026-06-29)

Status: design, pending review.

## Summary

Let a saved region include the vector basemap, so a downloaded region renders fully offline including
the base layer, not only the raster overlays. Today the region warm rejects the basemap (a
`mode:'style'` source) and the panel filters it out of the Sources list. This adds three things:

1. The basemap becomes a selectable source in the region Sources list, warmed like any other source
   but through the style vector-tile path.
2. The container warm engine learns to enumerate and pin a style source's vector tiles for a box,
   clamped to the basemap's native vector maxzoom.
3. A one-time global warm pins the basemap's font glyphs (common scripts) and its sprite, so labels
   and icons render offline. These assets are global, so they warm once and every region reuses them.

## Goals

- A region that includes the basemap renders fully offline: geometry, labels, and icons.
- Reuse the existing warm, budget, pin, `region_tiles`, eviction, and progress machinery. One seam.
- Never warm vector tiles above the basemap's native maxzoom (those upstream requests 404).
- Keep the container egress-isolated and Signal K agnostic.

## Non-goals (YAGNI)

- No per-region glyph or sprite sets. The glyphs and sprite are global, warmed once under a reserved
  pseudo-region.
- No non-Latin glyph coverage beyond the common-scripts range (U+0000 through U+2FFF). CJK, Arabic,
  and other scripts still need a connection for their labels.
- No raster-to-vector conversion, no offline style editing, no second basemap.

## Decisions (from brainstorming)

- Scope: full offline. Per region: the basemap vector tiles in the box. Once globally: the glyphs
  (common scripts) and the sprite.
- Selection: the basemap is a normal selectable source in the region Sources list, not a separate
  toggle and not forced on every region.
- Zoom: the basemap vector tiles warm at `[minzoom, min(regionMaxzoom, vectorMaxzoom)]`. MapLibre
  overzooms the cached top tiles past the native maxzoom, so the basemap still renders at every zoom.
- Glyphs: the common-scripts ranges (U+0000 through U+2FFF, about 48 ranges) per fontstack the style
  references.
- Native maxzoom source: a new `vectorMaxzoom` field on the basemap source in the shared registry is
  the single source of truth for the clamp. The container also reads the per-source maxzoom from the
  fetched style document and warms at the minimum of the two, so a registry value that drifts above
  the real style can never drive a 404 storm.
- Budget: the basemap vector tiles count under their region like raster (the estimate includes them,
  so the upfront budget gate accounts for them). The global assets pin under the reserved
  pseudo-region and count toward the regions budget R as a small real-region-equivalent (a few MB);
  no new budget knob.

## Architecture

Three seams extend, each in one place.

### Shared registry and the webapp

1. Registry. Add `vectorMaxzoom?: number` to the chart source type, set to 14 on the basemap source
   (the Liberty and OpenMapTiles native vector maxzoom). It is absent on raster sources.
2. Estimate. The webapp `estimate.ts` `regionSources()` stops filtering `mode:'style'`, so the
   basemap shows as a `LayerToggle` in the Sources list. The covering-source and estimate math clamp
   a source's maxzoom to `vectorMaxzoom` when present, so the basemap tile count, and therefore the
   regions-free budget gate, are computed at the native maxzoom, not the style maxzoom of 20.
3. The basemap renders offline already: `base-style.ts` points the map at the companion
   `/style/basemap`, and the vector tiles, glyphs, and (after this work) the sprite all route through
   the companion proxy, so a warmed basemap is served from cache with no connection.

### Container warm engine

1. Style awareness in `StyleState`. The style document fetch already learns each vector source's tile
   template into `source_tiles`. Extend it to also learn each vector source's `maxzoom` into a
   parallel `source_maxzoom` map, parsed from the same style document.
2. Warm a style source. `warm_start` currently rejects `mode:'style'` and builds an `Xyz`
   placeholder. Instead, when the warmed set includes the basemap: ensure the style document is
   fetched (so `StyleState` is populated), then for each of the style's vector sources, enumerate the
   box at `min(regionMaxzoom, registry vectorMaxzoom, source_maxzoom)` and warm those vector tiles
   through the existing style vector-tile fetch-and-cache path, pinned under the region in
   `region_tiles`. The raster sources in the same warm job are unaffected and warm as they do today.
3. The enumerator (`geom.rs`) is mode-agnostic XYZ math and is reused unchanged. Only the
   source-resolution branch (raster XYZ template versus a style vector source) and the upstream-URL
   construction change.

### Global assets warm

1. A reserved `__basemap_assets__` pseudo-region id (mirrors `__position_warm__`), defined once in
   the container and the plugin so both agree verbatim.
2. Trigger. The first time a region warm includes the basemap, the plugin also starts a global assets
   warm (idempotent: a re-run re-pins the same set, and an already-pinned asset is not double
   counted).
3. Glyphs. For each fontstack the style references (read from the style document layers' text-font),
   fetch the ranges `0-255` through `12032-12287` through the glyph proxy and pin them under
   `__basemap_assets__`. An empty range negative-caches at zero bytes.
4. Sprite. Add a `/style/:source/sprite/*` proxy route to the container (the sprite is not proxied
   today), rewrite the style document's `sprite` URL to it during the style proxy, and warm
   `sprite.json`, `sprite.png`, and the `@2x` variants, pinned under `__basemap_assets__`.

## Data flow

- Select and download: the user toggles the basemap on in a region's Sources, the estimate includes
  its clamped tile count, and the download posts the region with the basemap in `sourceIds`. The
  container warms the raster sources and the basemap vector tiles into the region, and the plugin
  kicks the one-time global assets warm.
- Offline render: MapLibre loads `/style/basemap`, and every vector tile, glyph, and sprite request
  is served from the pinned cache with no connection.
- Re-download and delete: a region that includes the basemap re-warms its vector tiles like any other
  source. Deleting the region drops its vector-tile pins by reference count; the global assets stay
  pinned under `__basemap_assets__` for the other regions.

## Units

Zoom levels are integers. Bytes are bytes. No SI unit conversion applies.

## Error handling

- A vector tile or glyph range that 404s negative-caches at zero bytes, so it costs no budget and is
  not re-fetched within the negative TTL.
- A style-document fetch failure fails only the basemap part of a warm job; the raster sources in the
  same job still warm, and the region reflects the partial result through the existing status
  reconcile.
- The global assets warm is best-effort and idempotent: a missed glyph range or a transient sprite
  failure re-warms on the next region that includes the basemap, with no duplicate pins.
- Warming the basemap never exceeds the budget silently: the estimate includes the basemap vector
  tiles, and the server-side gate refuses an over-budget region upfront, exactly as for raster.

## Testing

Rust (`cargo test --workspace`):

- A style source enumerates and pins its vector tiles for a box at the clamped maxzoom, recorded in
  `region_tiles` under the region.
- A warm with a region maxzoom above the native maxzoom warms no vector tiles above the native
  maxzoom.
- `source_maxzoom` is learned from the style document alongside `source_tiles`.
- The global assets warm pins the glyph ranges and the sprite under `__basemap_assets__`, and a
  second run adds no duplicate pinned bytes.
- The sprite route proxies and caches `sprite.json`, `sprite.png`, and the `@2x` variants.
- A 404 vector tile or empty glyph range negative-caches at zero bytes and does not trip the budget.

Plugin (`npm test`):

- A region whose `sourceIds` include the basemap triggers the global assets warm once.
- The basemap warm request resolves through the same warm route as raster.

Webapp (`vitest`):

- The basemap appears in `regionSources` and in the covering-source list for a box.
- The estimate clamps the basemap to `vectorMaxzoom`, so its tile count and the gate use the native
  maxzoom, not the style maxzoom.

chart-sources (`npm test`):

- The basemap source carries `vectorMaxzoom`, and `tileCountInBbox` honors the clamp when the caller
  passes the clamped zoom range.

## Consistency notes

- The style-source warm extends the one warm engine; it does not fork a second warm path.
- `__basemap_assets__` mirrors the `__position_warm__` pseudo-region pattern, so the pinning and the
  budget accounting reuse the existing region mechanics.
- The `vectorMaxzoom` clamp lives in the shared registry, so the estimate and the warm read one
  value; the container cross-checks it against the fetched style so the clamp is always at most the
  real native maxzoom.
- The new sprite route follows the existing `style.rs` proxy-route style: tokenless, Signal K
  agnostic, and egress-guarded.
