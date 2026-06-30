# Basemap region-warm Phase 2 design (2026-06-29)

Status: design, reviewed, pending user approval.

## Summary

Phase 1 made a saved region's basemap geometry render offline. Phase 2 adds the rest of the base map:
the font glyphs (so labels render) and the sprite (so icons and patterns render). These assets are
global, not per-region, so they warm once and every basemap region reuses them. All Phase 2 work is in
the container; the plugin and the webapp are unchanged.

Five pieces:

1. The container learns the style's fontstacks and its sprite base in the existing style-learn step.
2. Synthetic cache keys map a glyph range and a sprite variant onto the existing `tiles` table.
3. The glyph serve route gains a cache-first read (it is pass-through today), and a fontstack with
   spaces is keyed and fetched correctly (the current online glyph proxy is broken for a spaced
   fontstack, which Liberty uses).
4. A new sprite proxy route serves the sprite cache-first, and the style proxy rewrites the `sprite`
   URL to it.
5. The warm driver, when it warms a basemap region, also warms the global glyphs and sprite once,
   cache-first per key, pinned under a reserved `__basemap_assets__` pseudo-region.

## Goals

- A basemap region renders fully offline: geometry (Phase 1), labels, and icons (Phase 2).
- Reuse the existing tile cache, pin path, budget gate, and eviction through synthetic keys; add no
  second storage table.
- The assets warm is cache-first per key, so it is idempotent, recovers a partial set, and never
  re-fetches an already-pinned asset (no upstream hammering when several regions are saved in a row).
- Keep the container egress-isolated and Signal K agnostic; every asset fetch is host-checked against
  the style allowed hosts and uses the guarded egress path.

## Non-goals (YAGNI)

- No scripts beyond the common range U+0000 through U+2FFF. CJK, Arabic, and other scripts still need a
  connection for their labels.
- No per-region asset sets; the glyphs and sprite are global, warmed once under `__basemap_assets__`.
- No sprite or glyph decoding or subsetting; assets are stored as opaque upstream bytes (no image
  crate, so the runtime stays native-lib-free).

## Decisions (from brainstorming and review)

- Asset cache key: synthetic keys in the existing `tiles` table, reusing `put_many_pinned`,
  `pin_if_fresh`, `region_tiles`, the budget gate, and eviction.
  - Glyph range: `source = style:{source}:glyphs:{fontstack}`, `z = 0`, `x = rangeStart`, `y = 0`,
    where `fontstack` is the canonical DECODED comma-joined fontstack (the exact form the axum route
    yields after decoding the path param), and `rangeStart` is the first codepoint of the 256-wide
    range (0, 256, ..., 12032).
  - Sprite file: `source = style:{source}:sprite`, `z = 0`, `x = variantIndex`, `y = 0`, with
    `variantIndex` 0 for `.json`, 1 for `.png`, 2 for `@2x.json`, and 3 for `@2x.png`.
  - The `fontstack` is URL-encoded ONLY when building the upstream fetch URL, never in the cache key,
    so the warm-write key and the serve-read key are identical.
- Glyph coverage: ranges `0-255` through `12032-12287` (48 ranges, U+0000 through U+2FFF) for each
  fontstack the style references. Liberty references three: `Noto Sans Regular`, `Noto Sans Bold`, and
  `Noto Sans Italic` (names carry spaces).
- Trigger: folded into the container warm driver. When a warm's pre-expansion sources included a style
  source AND the region warm finished `Done`, the driver warms the global assets once.
- Cache-first per key: the assets warm skips any asset already fresh-and-pinned (`pin_if_fresh` on the
  synthetic key), and fetches only the misses. This is the idempotence, the partial-set recovery, and
  the no-hammer mechanism. There is no "skip when `__basemap_assets__` is non-empty" gate (it would
  strand a partial set).
- Single-flight: an `Arc<AtomicBool>` in `AppState`, claimed with `compare_exchange` and reset on
  every exit through an RAII guard, coalesces a concurrent first-run storm so two basemap downloads do
  not both fetch the full set at once. The per-key cache-first skip handles sequential saves.
- Budget: assets pin under `__basemap_assets__`, counting once toward the regions budget R through the
  existing `real_region_pinned_bytes` EXISTS dedup (it excludes only `__position_warm__`). The few-MB
  footprint is not pre-reserved by the first basemap region's upfront gate, so a small one-time
  overshoot of R is accepted and documented; the cap-clamped gate, make-room evicting only unpinned,
  and never evicting a pinned tile still hold the physical total at or below the cap.

## Architecture (container `container/tilecache`)

### Learn fontstacks and sprite base

`StyleState` gains `fontstacks: Vec<String>` (the distinct `text-font` arrays from the style layers,
each comma-joined into the canonical decoded form, tolerant of a non-string-array value so a
data-driven `text-font` cannot panic) and `sprite_base: Option<String>` (the style's `sprite` URL).
Both are parsed in `fetch_and_learn` from the already-fetched style document, so no extra fetch is
added. A style with no sprite leaves `sprite_base` `None` and warms glyphs only.

### Synthetic key helpers and a status-returning asset fetch

Small pure helpers map an asset to its synthetic key:

- `glyph_cache_source(style_source, fontstack) -> String` (`style:{src}:glyphs:{fontstack}`)
- `sprite_cache_source(style_source) -> String` (`style:{src}:sprite`)

A status-returning fetch is required (the existing `fetch_bytes` collapses any non-200 to `None` and
drops the status, so it cannot negative-cache a 404). The glyph route, the sprite route, and the
assets warm use a status-returning fetch like `fetcher::fetch_upstream`, each preceded by an explicit
`host_allowed(upstream, allowed_hosts)` check (the guarded egress path blocks only private and
loopback IPs, not an off-allowlist public host).

Assets are stored by building a `CachedTile` and `WarmRow` directly and calling the cache put, NOT
through `warm_one`: `acceptable_content_type` accepts only image and protobuf types and would reject
the sprite JSON (`application/json`), so the assets path stores the bytes directly, the way the
vector-tile route already does.

### Glyph route cache-first

The glyph serve route, today a pass-through, becomes cache-first like the vector-tile route: parse
`rangeStart` from the `:range` param (strip `.pbf`, split on `-`, take the start; ignore a
non-256-aligned range so a crafted range cannot mis-key), compute the glyph key, serve a cached 200
hit, serve a cached negative as a 404 (so MapLibre treats the range as absent, not an error), and on a
miss fetch upstream (URL-encoding the fontstack segment), store under the key, and serve. The warm
writes the identical key, so a warmed glyph serves offline.

### Sprite route

Four explicit routes, because MapLibre appends the variant suffix to the sprite base with no slash
(`sprite.json`, `sprite.png`, `sprite@2x.json`, `sprite@2x.png`): `/style/:source/sprite.json`,
`/style/:source/sprite.png`, `/style/:source/sprite@2x.json`, and `/style/:source/sprite@2x.png`. Each
maps to its variant index, reconstructs the upstream from the learned `sprite_base` plus the suffix,
host-checks it, serves cache-first under the sprite key, and on a miss fetches, stores, and serves. The
style proxy rewrites the style document's `sprite` value to `{public}/style/{source}/sprite`.

### Assets warm driver, folded into `run`

`run` captures, BEFORE the `expand_warm_sources` call that replaces the style source with synthetic XYZ
sub-sources, whether any source was a style source and that source's id (the original id is needed to
look up the learned glyph template, fontstacks, and sprite base). After the region-tile enumeration,
only when the job finished `Done` and a style source was present, it runs the assets warm:

- Claim the single-flight flag (`compare_exchange`); if already set, skip (another warm is fetching
  the set). Reset the flag on every exit via an RAII guard.
- For each learned fontstack and each of the 48 ranges, and for each present sprite variant, compute
  the synthetic key, skip it with `pin_if_fresh` under `__basemap_assets__` when already fresh-pinned,
  else fetch (host-checked, status-returning), build a `WarmRow` directly, and batch.
- Flush the batches with `put_many_pinned` under `__basemap_assets__` and that pseudo-region's
  effective budget, bounded by the existing `warm_semaphore` so the roughly 148 one-time fetches stay
  polite against live reads.
- The assets warm uses its own counters and does not change the region job's `total` or `done`. The
  region job reads `done == total` while the assets phase runs; the panel shows the region as complete,
  which is correct (the region tiles are done).

`__basemap_assets__` is a container constant mirroring `POSITION_WARM_REGION_ID`.

## Data flow

- Warm: a basemap region warm learns the style, warms the region vector tiles, and on a `Done` result
  warms the global glyphs and sprite once, cache-first per key, under `__basemap_assets__`.
- Offline render: MapLibre loads `/style/basemap`; vector tiles, glyphs, and the sprite all serve
  cache-first from the pinned cache with no connection.
- Eviction: the assets are pinned, so the scroll-cache LRU, the age sweep, and the manual clear never
  touch them. Deleting a region drops that region's vector-tile pins by reference count; the global
  assets stay pinned under `__basemap_assets__`.

## Error handling

- A 404 glyph range or a missing sprite variant negative-caches at zero bytes (status-returning
  fetch), so it costs no budget and is not re-fetched within the negative TTL; the glyph route serves a
  cached negative as a 404.
- The assets warm is best-effort, cache-first, and idempotent: a partial set (an interrupted or
  budget-capped run) completes on the next basemap region warm, and an already-pinned asset is skipped,
  so a re-run adds no duplicate pinned bytes and no duplicate fetch.
- The assets warm runs only on a `Done` region warm. On a `Cancelled`, `Capped`, or `Error` region
  warm the assets are not warmed; the next successful basemap region warm warms them. A region warm
  that caps because the budget is full means the labels and icons are not yet offline, which is the
  documented consequence of a full budget.
- A style with no sprite warms glyphs only; the sprite routes return not found and the rewrite leaves
  no sprite URL.
- Reclamation: `__basemap_assets__` is never deleted, so deleting the last basemap region leaves the
  assets pinned, holding a few MB of R. This is accepted and documented; a later refinement could
  reclaim the assets when no saved region includes the basemap.

## Testing

Rust (`cargo test --workspace`). The existing style stub has `"layers":[]` and no sprite; the fixtures
add a layer with a multi-word `text-font` and a `sprite` URL.

- `fetch_and_learn` records the fontstacks (multi-word, canonical decoded) from the style layers and
  the sprite base from the style `sprite` URL.
- Warm then serve a multi-word fontstack glyph (for example `Noto Sans Regular`): the second serve hits
  the cache with no upstream fetch, proving the warm-write and serve-read keys match.
- `GET /style/basemap/sprite.json` (no slash) returns 200 and caches, and the style proxy rewrites the
  `sprite` value to the plugin path.
- The assets warm pins the glyph ranges and the sprite under `__basemap_assets__`; a second run adds no
  duplicate pinned bytes and makes no second upstream fetch (cache-first).
- A partial assets set (a first run interrupted before completion) completes on the next basemap warm.
- Two concurrent basemap warms fetch each glyph upstream at most once (single-flight).
- A basemap region warm triggers the assets warm; a non-basemap warm does not.
- A 404 glyph range negative-caches at zero bytes and the glyph route serves it as a 404.
- A sprite-absent style warms glyphs only and the sprite routes return not found.

## Consistency notes

- The assets reuse the one tile cache through synthetic keys, the one pin path (`put_many_pinned` and
  `pin_if_fresh`), and the one budget gate; no second storage or pin path.
- `__basemap_assets__` mirrors `__position_warm__`, counting once toward R through the existing EXISTS
  dedup.
- The sprite and glyph routes follow the existing `style.rs` proxy style: tokenless, Signal K agnostic,
  cache-first, host-checked, and status-returning.
- The assets warm folds into the one warm driver, so a fresh download and a redownload both trigger it
  with no new plugin route, no new container warm route, and no plugin or webapp change.
- A vector source literally named `sprite` or `glyphs:<x>` would collide with an asset key; such a name
  is reserved (near-impossible in a real style, noted).
