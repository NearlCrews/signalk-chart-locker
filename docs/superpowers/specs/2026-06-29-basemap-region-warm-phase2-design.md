# Basemap region-warm Phase 2 design (2026-06-29)

Status: design, pending review.

## Summary

Phase 1 made a saved region's basemap geometry render offline. Phase 2 adds the rest of the base map:
the font glyphs (so labels render) and the sprite (so icons and patterns render). These assets are
global, not per-region, so they warm once and every basemap region reuses them.

Three pieces:

1. The container learns the style's fontstacks and its sprite base (alongside the glyph and tile
   templates it already learns), and caches glyphs and the sprite through the existing tile cache
   under synthetic keys.
2. A new sprite proxy route, and a cache-first read on the existing glyph route, so a warmed glyph or
   sprite serves offline.
3. The warm driver, when it warms a basemap region, also warms the global glyphs and sprite once,
   pinned under a reserved `__basemap_assets__` pseudo-region.

## Goals

- A basemap region renders fully offline: geometry (Phase 1), labels, and icons (Phase 2).
- Reuse the existing tile cache, pin, budget, and eviction machinery through synthetic keys; add no
  second storage table and no second pin path.
- Keep the container egress-isolated and Signal K agnostic; the sprite and glyph fetches use the same
  guarded egress path and the style host allowlist the proxy already enforces.
- No plugin change: the container warms the assets itself whenever it warms a basemap region, so both
  a fresh download and a redownload trigger it with no new route.

## Non-goals (YAGNI)

- No non-Latin scripts beyond the common range (U+0000 through U+2FFF). CJK, Arabic, and other scripts
  still need a connection for their labels.
- No per-region asset sets; the glyphs and sprite are global, warmed once under `__basemap_assets__`.
- No sprite editing or glyph subsetting; the assets are stored as opaque upstream bytes.

## Decisions (from brainstorming)

- Asset cache key: synthetic keys in the existing `tiles` table, so the assets reuse `put_many_pinned`,
  `region_tiles`, the budget gate, eviction, and the cache-first serve. No new table.
  - Glyph range: `source = style:{source}:glyphs:{fontstack}`, `z = 0`, `x = rangeStart`, `y = 0`,
    where `rangeStart` is the first codepoint of the 256-wide range (0, 256, 512, and so on).
  - Sprite file: `source = style:{source}:sprite`, `z = 0`, `x = variantIndex`, `y = 0`, where the
    variant index is `0` for the JSON, `1` for the PNG, `2` for the `@2x` JSON, and `3` for the `@2x`
    PNG.
- Glyph coverage: the common-scripts ranges U+0000 through U+2FFF (ranges `0-255` through
  `12032-12287`, 48 ranges) for each fontstack the style references. Liberty references three: Noto
  Sans Regular, Bold, and Italic.
- Trigger: folded into the container warm driver. When a warm includes a style (basemap) source, the
  driver warms the global assets once after the region tiles, additive (it never deletes the
  `__basemap_assets__` pins) and single-flight (a concurrent or very recent assets warm is skipped),
  and the assets warm does not count toward the region job's progress total.
- Budget: the assets pin under `__basemap_assets__`, counting once toward the regions budget R through
  the existing `real_region_pinned_bytes` EXISTS dedup. They are a few MB; the first basemap region's
  upfront gate does not pre-reserve them, so a small one-time overshoot of R is accepted and
  documented. No new budget knob.

## Architecture

All Phase 2 work is in the container (`container/tilecache`). The webapp and the plugin are unchanged.

### Learn the fontstacks and the sprite base

`StyleState` gains `fontstacks: Vec<String>` (the distinct `text-font` arrays from the style layers,
each joined with commas and URL-encoded the way the glyph route expects) and `sprite_base:
Option<String>` (the style's `sprite` URL). Both are parsed in `fetch_and_learn` (Phase 1's shared
learn helper) from the already-fetched style document, so no extra fetch is added. A style with no
sprite leaves `sprite_base` `None`.

### Synthetic asset keys and a cache-first glyph route

A small key helper maps an asset to its synthetic `(source, z, x, y)`:

- `glyph_key(style_source, fontstack, range_start) -> (String, u32, u32, u32)`
- `sprite_key(style_source, variant_index) -> (String, u32, u32, u32)`

The glyph serve route (today a pass-through) gains a cache-first read on `glyph_key`, then on a miss
fetches the upstream, stores it under the same key, and serves it, mirroring the vector-tile route.
The warm writes the identical key, so a warmed glyph serves offline.

### A sprite proxy route

A new `GET /style/:source/sprite/*tail` route serves the sprite cache-first under `sprite_key`. The
`*tail` is the variant suffix MapLibre requests (`.json`, `.png`, `@2x.json`, `@2x.png`); the route
maps it to a variant index, reconstructs the upstream URL from the learned `sprite_base`, host-checks
it against the style allowed hosts, fetches and caches it, and serves it. The style proxy rewrites the
style document's `sprite` value to `{public}/style/{source}/sprite` so MapLibre fetches the variants
through the route. `StyleState` must hold `sprite_base` for the route to reconstruct the upstream.

### The assets warm driver

A new function warms the global assets, pinned under `__basemap_assets__`:

- For each learned fontstack, for each of the 48 common-scripts ranges, fetch the glyph through the
  learned glyph template, build a `WarmRow` with `glyph_key`, and batch.
- For each sprite variant present (derived from `sprite_base`), fetch it, build a `WarmRow` with
  `sprite_key`, and batch.
- Flush the batches with `put_many_pinned` under `__basemap_assets__` and the effective budget for
  that pseudo-region, so the assets pin and count toward R like any region. It never calls
  `delete_region` on `__basemap_assets__` (the assets warm is additive, not a replace).

The warm driver (`run`), after the region-tile enumeration, calls this once when the job's sources
included a style source, guarded by a single-flight flag in `AppState` (an `AtomicBool` set for the
duration, plus a skip when `__basemap_assets__` already holds the expected pinned set) so two
concurrent basemap downloads do not both fetch the assets. The assets warm uses its own counters and
does not change the region job's `total` or `done`.

### Reserved id

`__basemap_assets__` is defined once as a container constant (mirroring `POSITION_WARM_REGION_ID`).
The plugin does not need it (the container drives the assets warm), but the constant is documented
next to `POSITION_WARM_REGION_ID`.

## Data flow

- Warm: a basemap region warm learns the style (Phase 1), warms the region's vector tiles, then warms
  the global glyphs and sprite once under `__basemap_assets__`.
- Offline render: MapLibre loads `/style/basemap`; vector tiles (Phase 1), glyphs, and the sprite all
  serve cache-first from the pinned cache with no connection.
- Eviction: the assets are pinned, so the scroll-cache LRU, the age sweep, and the manual clear never
  touch them. Deleting a region drops that region's vector-tile pins by reference count; the global
  assets stay pinned under `__basemap_assets__`.

## Error handling

- A 404 glyph range or a missing sprite variant negative-caches at zero bytes (the status-returning
  fetch path), so it costs no budget and is not re-fetched within the negative TTL.
- The assets warm is best-effort and idempotent: a missed range re-warms on the next basemap region
  warm, and `put_many_pinned` plus `pin_if_fresh` dedup, so a re-run adds no duplicate pinned bytes.
- A style with no sprite (`sprite_base` is `None`) warms glyphs only; the sprite route returns not
  found, and the rewrite leaves no sprite key.
- The few-MB asset footprint can nudge the pinned set a little above R on the first basemap region;
  the cap-clamped budget gate, make-room evicting only unpinned, and never evicting a pinned tile
  still hold the physical total at or below the cap, so this is graceful, not a bug.

## Testing

Rust (`cargo test --workspace`):

- `fetch_and_learn` records the fontstacks from the style layers and the sprite base from the style
  `sprite` URL.
- The glyph route serves a cached glyph without an upstream fetch after a warm (cache-first), keyed by
  the synthetic glyph key.
- The sprite route proxies and caches each variant under the synthetic sprite key, and the style proxy
  rewrites the `sprite` value to the plugin path.
- The assets warm pins the glyph ranges and the sprite under `__basemap_assets__`, and a second run
  adds no duplicate pinned bytes (idempotent).
- A basemap region warm triggers the assets warm once; a non-basemap warm does not.
- A 404 glyph range negative-caches at zero bytes.

## Consistency notes

- The assets reuse the one tile cache through synthetic keys, the one pin path (`put_many_pinned`), and
  the one budget gate; no second storage or pin path is introduced.
- `__basemap_assets__` mirrors the `__position_warm__` pseudo-region, counting once toward R through
  the existing EXISTS dedup.
- The sprite route follows the existing `style.rs` proxy-route style: tokenless, Signal K agnostic,
  cache-first, and host-checked against the style allowed hosts.
- The assets warm folds into the one warm driver, so a fresh download and a redownload both trigger it
  with no new plugin route or trigger.
