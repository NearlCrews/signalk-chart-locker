# Basemap region-warm design (2026-06-29)

Status: design, reviewed, split into two phases. This document specifies Phase 1.

## Why two phases

The goal is a region that renders fully offline including the base layer: geometry, labels, and
icons. The base map is the OpenFreeMap Liberty vector style. Its three offline ingredients have very
different shapes in the cache:

- Vector tiles are real `(source, z, x, y)` tiles. They fit the existing tile cache, the warm
  enumerator, the `region_tiles` pins, the budget gate, and the eviction rules with a focused
  extension. This is Phase 1.
- Font glyphs (keyed by fontstack and codepoint range) and the sprite (a small fixed set of files)
  have no `z/x/y`, are served uncached today, and need a synthetic cache key, a cache-first serve
  path, and a new sprite route. This is Phase 2, specified separately.

Phase 1 makes a region's geometry render offline (coastlines, depth areas, roads, and water). Phase 2
adds labels and icons. Shipping Phase 1 first is the low-risk, high-value half; Phase 2 builds on the
same style-learning groundwork Phase 1 lays.

## Phase 1 summary

Let a saved region include the base map's vector tiles, so the region's geometry renders offline.
Today the region warm rejects a `mode:'style'` source and the panel filters it out of the Sources
list. Phase 1:

1. Makes the base map a selectable source in the region Sources list (only there, not in the
   position-warm list).
2. Teaches the container warm engine to learn the style, enumerate each in-style source's tiles for a
   box clamped to that source's native maxzoom, and pin them under the region through the existing
   style tile cache path.
3. Adds a `vectorMaxzoom` field to the base map source so the estimate and the warm clamp at the
   native vector maxzoom (14), not the style overzoom ceiling (20).

## Goals

- A region that includes the base map renders its geometry offline.
- Extend the one warm engine and the one tile cache; do not fork a second warm path.
- Never enumerate or warm above a source's native maxzoom (those upstream requests overrun the warm
  hard cap and 404).
- Keep the container egress-isolated and Signal K agnostic.

## Non-goals (Phase 1)

- No glyphs and no sprite. Labels and icons are Phase 2. A Phase-1 region renders geometry but not
  text or symbols offline.
- The base map is never added to the position-warm Sources list (warming a whole basemap on every
  GPS fix is wrong); it is a region-download source only.
- No second base map, no offline style editing.

## Decisions

- Selection: the base map is a normal selectable source in the region Sources list, listed but NOT
  auto-selected when a box is drawn (it is global, so it would always auto-select and routinely blow
  the budget). The user opts it in per region.
- Zoom clamp: a source's tiles warm at `[minzoom, min(regionMaxzoom, nativeMaxzoom)]`. For the base
  map `nativeMaxzoom` is the registry `vectorMaxzoom` (14), cross-checked in the container against the
  per-source maxzoom learned from the style. MapLibre overzooms the cached top tiles past the native
  maxzoom, so the base map still renders at every zoom.
- All in-style sources warm: the Liberty style carries a vector source (`openmaptiles`) and an
  in-style raster source (`ne2_shaded`, maxzoom 6). The warm pins both, each clamped to its own
  learned maxzoom, so the shaded relief is offline too.
- The clamp lives in the shared enumerator, not the caller (see HIGH-1 below).

## Architecture

Four seams extend, each in one place. The webapp pieces live in the sibling `signalk-binnacle` repo;
the registry lives in `signalk-binnacle-chart-sources`; the warm engine and the server-side gate live
in this repo.

### Shared registry (`signalk-binnacle-chart-sources`)

1. Add `vectorMaxzoom?: number` to the `ChartSource` type, set to 14 on the base map source, absent
   on raster sources. Document in the type that `maxzoom` is the MapLibre overzoom render ceiling and
   `vectorMaxzoom` is the native vector-tile maxzoom used for warm and estimate.
2. Clamp inside the enumerator, not the caller. `tileCountInBbox` and `tilesInBbox` clamp through
   `zoomBounds` (in `mercator.ts`), which today does `Math.min(zmax, source.maxzoom)`. Change it to
   `Math.min(zmax, source.maxzoom, source.vectorMaxzoom ?? source.maxzoom)`. Then every caller, the
   webapp estimate, the covering-source list, and the plugin's server-side re-validation, honors the
   clamp with no caller change. This is the one seam for the clamp.

### Webapp (`signalk-binnacle`)

1. The region Sources list stops filtering `mode:'style'`, so the base map shows as a `LayerToggle`.
   The position-warm Sources list keeps filtering style out, so the base map never enters position
   warm. (Today both lists are built from the same `regionSources()`, so this requires either a
   separate position-warm source list or an explicit style filter at the position-warm list site.)
2. A new box auto-selects every covering source today; exclude the base map id from that auto-select
   default, so it is listed but off by default.
3. The estimate and the gate clamp automatically through the registry change above.
4. Flip the two existing tests that assert the base map is excluded (`estimate.test.ts`), to assert
   it is present in `regionSources()` and in the covering-source list for a non-empty box, clamped to
   `vectorMaxzoom`. Update the stale JSDoc and panel comments that say the style base map is excluded.

### Container warm engine (`container/tilecache`)

1. `vector_maxzoom` on the Rust `ChartSource`: add `#[serde(default)] pub vector_maxzoom: Option<u32>`
   (non-breaking; no `deny_unknown_fields`). The config push already ships the whole registry.
2. Learn the style from the warm path. Extract the style fetch-and-learn from the GET `/style/:source`
   route into an `ensure_style_learned(state, source)` helper that populates `StyleState`, and call it
   from both the route and the warm. Extend `StyleState` to also learn, per in-style source, its
   maxzoom (inline for `ne2_shaded`, and from the TileJSON at the source's `url` for `openmaptiles`).
3. A dedicated style-warm branch. `warm_start`/`run` today build an `Xyz` placeholder and call
   `expand_upstream`, which rejects a style source. Add a branch: when the warmed source is the base
   map, ensure the style is learned, then for each in-style source enumerate the box at
   `min(regionMaxzoom, vector_maxzoom, learned source_maxzoom)` and fetch each tile through the
   existing style vector-tile cache path, keyed `style:{source}:{name}` to match the serve key, pinned
   under the region in `region_tiles` via the existing pin path. Raster sources in the same job warm
   unchanged.
4. The pre-flight `total` in `start_warm` must include the base map's clamped tile count (computed
   from the registry `vector_maxzoom`, because the style is not yet fetched at that point), so the
   warm hard cap is enforced and the progress bar denominator is right.
5. Use a status-returning upstream fetch for the style vector path (the current `fetch_bytes`
   collapses any non-200 to `None` and drops the status), so a 404 vector tile negative-caches at zero
   bytes and a 5xx is not cached.

### Server-side gate (`src/http/regions-routes.ts`)

The upfront `POST /api/regions` re-validation calls `estimateBytes(sourceIds, ...)` against
`perSourceAvgBytes`. The base map's tiles store under the cache key `style:basemap:openmaptiles`, so
`perSourceAvgBytes` has no `basemap` key and the estimate falls back to the default per-tile size.
Phase 1 accepts this default-average fallback: `DEFAULT_TILE_BYTES` is a conservative upper bound
(vector tiles are typically smaller), so the gate over-reserves slightly rather than under-gating.
Document it; a precise per-style-source average is a later refinement.

## Data flow

- Select and download: the user toggles the base map on in a region's Sources, the estimate includes
  its clamped tile count, and the download posts the region with `basemap` in `sourceIds`. The
  container learns the style, enumerates each in-style source clamped to its maxzoom, and pins the
  tiles under the region.
- Offline render: MapLibre loads `/style/basemap`; every vector tile request is served from the
  pinned cache. Labels and icons still need a connection until Phase 2.
- Re-download and delete: the base map re-warms like any source; deleting the region drops its tile
  pins by reference count.

## Error handling

- A 404 vector tile negative-caches at zero bytes (status-returning fetch), so it costs no budget and
  is not re-fetched within the negative TTL. (An upstream that returns a 200 empty tile caches as a
  small real row, not zero; either way the budget is respected.)
- A style-document fetch failure fails only the base map part of a warm job; the raster sources in the
  same job still warm, and the region reflects the partial result through the existing status
  reconcile.
- The base map warm respects the budget exactly as raster: the estimate includes its clamped tiles
  and the server-side gate refuses an over-budget region upfront.

## Testing

chart-sources (`npm test`):

- The base map source carries `vectorMaxzoom`, and `tileCountInBbox` clamps to it internally even when
  the caller passes a higher maxzoom.

Webapp (`vitest`):

- The base map appears in `regionSources()` and in the covering-source list for a non-empty box.
- The position-warm Sources list still excludes the base map.
- A new box does not auto-select the base map.
- The two prior tests that asserted exclusion are flipped to assert inclusion with the clamp.

Rust (`cargo test --workspace`):

- `ensure_style_learned` populates `StyleState` with each in-style source's tile template and maxzoom,
  learning the vector source's maxzoom from its TileJSON.
- A style source enumerates and pins its tiles for a box at the clamped maxzoom, recorded under the
  region in `region_tiles`, keyed `style:{source}:{name}`.
- A region maxzoom above the native maxzoom warms no tiles above the native maxzoom.
- The pre-flight `total` includes the base map's clamped count, and an oversized base map box trips
  the warm hard cap rather than enumerating past it.
- A 404 vector tile negative-caches at zero bytes and does not trip the budget.

Plugin (`npm test`):

- A region whose `sourceIds` include the base map resolves through the same warm route as raster and
  the server-side gate accepts a within-budget base map region.

## Phase 2 (deferred, separate spec): glyphs and sprite

Phase 2 adds offline labels and icons. The leading design, to settle in its own spec and review:

- A reserved `__basemap_assets__` pseudo-region (mirrors `__position_warm__`), warmed once.
- Glyphs pinned under synthetic tile keys, for example
  `source = style:basemap:glyphs:{fontstack}`, `z = 0`, `x = rangeStart`, `y = 0`, for the common
  scripts ranges (U+0000 through U+2FFF) of each fontstack the style references (Liberty uses three:
  Noto Sans Regular, Bold, and Italic). `StyleState` retains the fontstack set at learn time.
- The sprite pinned under `source = style:basemap:sprite`, `x = variant index`, for the JSON, PNG, and
  `@2x` variants. The sprite base is `.../sprites/ofm_f384/ofm`; the variants are derived from that
  learned base, not hardcoded.
- A new `/style/:source/sprite/*` route and a cache-first read added to the glyph route, with the
  warm-write key equal to the serve-read key.
- The style proxy rewrites the `sprite` URL to the new route and `StyleState` learns the sprite base.
- The assets warm is triggered wherever a base map region warm starts (`POST /api/regions` and the
  redownload route), guarded single-flight so two concurrent base map downloads do not race
  delete-and-repin on the shared `__basemap_assets__` id, and idempotent so a re-run adds no duplicate
  pinned bytes. A small fixed assets reserve is added to the first-base-map gate, or the few-MB
  one-time overshoot is accepted explicitly.

## Consistency notes

- The clamp is one value in the shared registry, read by the estimate, the covering-source list, the
  server-side gate, and the container warm, with the container cross-checking it against the learned
  style maxzoom so the clamp is always at most the real native maxzoom.
- The style-source warm extends the one warm engine and writes tiles under the same
  `style:{source}:{name}` key the serve path reads, so warmed tiles serve offline with no new cache
  path.
- `__basemap_assets__` (Phase 2) mirrors the `__position_warm__` pseudo-region, counting once toward
  the regions budget R through the existing `real_region_pinned_bytes` EXISTS dedup.
