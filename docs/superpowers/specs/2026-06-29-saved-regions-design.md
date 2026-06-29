# Saved regions and region download

Design spec. Date 2026-06-29. Sub-project 1 of the companion caching vision (after the route-draft
removal, the companion is a tile cache and PMTiles chart provider only). It builds on the shipped tile
cache (v1 read-through cache), the v2 prewarm (the warm-job engine, pinning, the estimate gate, the
prewarm panel), and v3 PMTiles. It supersedes the single-box v2 prewarm with a multi-region, saved, and
downloadable model.

This design was reviewed against correctness, the trust boundary, plan quality, and codebase fit before
finalizing, and every finding is folded in below.

## 1. Goal

Let the owner draw a box, download all the free covering raster overlays for it into the boat-wide cache
with one action, auto-name it by place, and keep it as a durable named region in the UI. Saved regions
are offline-durable; the on-demand scroll cache is ephemeral.

## 2. Scope

In scope: the saved-region entity and storage, the one-click region download of the raster overlays, the
two-budget durable cache, per-region delete and re-download, place-name auto-naming via a geocoder, and
the panel evolution from one box to a region list.

Out of scope (deferred, each its own later sub-project):
- The basemap region download. The basemap is a `style` source; the warm engine rejects style sources and
  `tileCountInBbox` cannot enumerate a vector style (its assets are the style document, the referenced
  vector tiles, the glyph ranges, and the sprite). Region download here covers the raster overlays only,
  matching the v2 scope; the basemap stays cached on-demand (v1) for viewed areas. A follow-on adds a
  dedicated basemap region-warm path through the style proxy.
- TTL eviction of the scroll cache. Today eviction is pure LRU (`evict_to` by `last_access`); a
  time-based eviction sweep is net-new and belongs to the later "cache TTL and management" sub-project.
  Here the scroll cache stays LRU-only.
- Scheduled region refresh, the broader cache stats and management UI, the Crow's Nest data cache, and
  the automap and layer declutter.

## 3. Locked decisions

- Region download covers the raster overlays only; the basemap and TTL are deferred (section 2).
- Auto-name: the companion reverse-geocodes the box center via an allowlisted geocoder, shown editable in
  the UI, with a coordinate-derived fallback. The lookup fires only on the explicit Download action.
- Storage: a hard-reserved two-budget model. Saved regions are pinned and durable within a regions budget
  R; the scroll cache is LRU within `cap - R`. A region download that will not fit R is refused upfront,
  authoritatively server-side.
- Enumeration and the byte estimate stay in the webapp panel (live, client-side); the companion is the
  executor, not the selector.
- The single-box v2 prewarm migrates into the regions list; position-warm is repointed to the list.

## 4. The region entity and storage (companion plugin owns it)

`SavedRegion { id, name, bbox, sourceIds[], minzoom, maxzoom, createdAt, lastDownloadedAt, bytes, status }`
where `status` is one of `downloading`, `ready`, `capped`, or `error`. Persisted as a JSON list in the
existing `prewarm.json` under `app.getDataDirPath()` via the shared `json-state` helper.

- Migration: on load, a non-null top-level `bbox` from the v2 single-box `PrewarmConfig` becomes one
  `SavedRegion`, then the top-level box fields are dropped. The `positionWarm` block stays a separate
  top-level block in the same file. A migration test covers this.
- `bytes` is a last-download snapshot, labeled as such in the UI; the authoritative per-region size for
  the stats comes from the cache (`SELECT SUM(bytes) WHERE region_id = ?`).
- `status` is reconciled against the actual download outcome: a `capped` warm leaves the region `capped`
  with the partial bytes recorded; a lost job (the container restarted, the status poll returns no job)
  leaves it `error` or `capped`, never stuck at `downloading`. A schema-version cache wipe (section 5)
  marks every persisted region `needs-redownload` (a `status` that prompts a re-download), so the UI never
  shows a durable region whose tiles are gone.

## 5. The container cache: two budgets and shared-tile pins

The cache today has one running `total_bytes` and one `cap_bytes`; `evict_to(cap_bytes)` evicts unpinned
rows; `put_many_pinned` checks against `cap_bytes` with `base = total_bytes`. This sub-project changes
that as follows (one SCHEMA_VERSION bump, to 3, covers all of it; the existing drop-and-recreate path
wipes the cache, hence the `needs-redownload` handling in section 4).

- Shared-tile pinning via a join table. A tile shared by two overlapping regions cannot be a single
  `region_id` column on the one `(source, z, x, y)` row. Add a `region_tiles(region_id, source, z, x, y)`
  join table. A tile stays pinned while ANY region references it. Per-region delete removes that region's
  join rows and unpins (and demotes to the scroll cache, LRU-eligible) only the tiles whose reference
  count reached zero, then evicts them under the scroll budget if needed.
- Hard-reserved two budgets. Track `pinned_bytes` separately. The regions budget R is a reservation; the
  scroll cache gets `S = cap - R`.
  - The region warm gates on `pinned_bytes + delta <= R` (in `put_many_pinned`, basing the check on
    `pinned_bytes`, not `total_bytes`, so it does not double-count the scroll cache).
  - The live-proxy and style scroll-eviction call sites change from `evict_to(cap_bytes)` to
    `evict_to(cap_bytes - R)`, so the scroll cache is bounded at S.
  - With pinned `<= R` and scroll `<= S`, the physical total stays `<= cap` automatically, so a warm
    never evicts (the v2 invariant holds), and a region download that passes the gate is guaranteed to
    fit (no surprise mid-warm `capped`).
  - The pin paths (`pin`, `pin_if_fresh`) used when a warm pins an already-cached scroll tile must update
    `pinned_bytes` and respect R, so a skip-but-pin cannot push `pinned_bytes` past R.
- `R` and a changed `cap` reach the container via the `POST /config` push (a live value), not the
  start-only `TILECACHE_CAP_BYTES` env, so "raise the cap" and the regions budget are settable without a
  container restart.
- `GET /cache/stats` is extended to report the split: regions-used (`pinned_bytes`), scroll-used, R, and
  free space within R, so the panel can gate and the owner can see why the scroll cache is bounded.

## 6. The download flow

1. The panel (client-side) enumerates the candidate sources: every registry raster source that covers the
   box, where covers means the source has no `bounds` (global) OR its `bounds` intersects the box, using
   `tileCountInBbox(source, bbox, zoomRange) > 0` as the predicate (this reuses the shared tile math and
   correctly includes the global sources). The basemap (a style source) is excluded.
2. The panel computes the live byte estimate (`tileCountInBbox` times the per-source average from
   `/api/cache/stats`, with the shared `DEFAULT_TILE_BYTES` fallback for an un-sampled source) summed over
   the selected sources, and gates against regions-free = `R - pinned_bytes`. Download is disabled while
   the estimate exceeds regions-free.
3. On the Download action the panel reverse-geocodes the box center once (section 7) for the default name,
   then POSTs the region (bbox, the chosen sourceIds, the zoom range, the name) to the plugin.
4. The plugin re-validates the estimate against R server-side (authoritative, not the bypassable panel
   gate), persists the SavedRegion with `status: downloading`, and starts a warm job tagged with the
   region id. The warm reuses the v2 engine (the SSRF guards, the egress semaphore, the body cap, the
   content-type validation, the in-memory job registry, and the `put_many_pinned` net-delta check)
   unchanged except for the region tag and the R-based gate.
5. On completion the plugin reconciles `status` (ready, or capped with partial bytes) and
   `lastDownloadedAt`. If the server-side re-validation fails, the download is refused before the entity
   is persisted or the job starts.
6. Re-download re-runs the warm for the same region id, replacing that region's tiles; the net-delta cap
   check makes a re-warm of unchanged tiles cheap. It does not create a duplicate region.

## 7. Geocoding (egress stays in the container)

A dedicated container route `GET /geocode?lat=&lon=` (not the tile-source allowlist) reverse-geocodes via
Nominatim:
- It targets the hardcoded allowlisted host `nominatim.openstreetmap.org` at `/reverse?format=jsonv2`,
  checked with a host allowlist (the IP guard alone is not enough), with the v2 SSRF guards (the guarded
  resolver, private-IP rejection, redirects off) and `read_capped` on the body.
- It sends a descriptive, contactable User-Agent (an identifiable application name and a contact),
  per the Nominatim usage policy; the lookup is at most one request per Download, debounced, never on
  rectangle drag, so the 1 request per second policy and the owner's position privacy both hold.
- It validates `lat` and `lon` as finite and in range and formats them as numbers before building the URL.
- The plugin proxies it at `GET /api/geocode`; the panel shows the result editable and falls back to a
  coordinate-derived name on any failure.
- Privacy: reverse-geocoding sends the box-center coordinate to a third party. This is the owner's
  explicit, online, one-coordinate action at download time with an editable name, not background
  telemetry; the panel surfaces that the name came from an online lookup.

## 8. Plugin routes (admin-gated, reusing the v2 admin gate and the relay pattern)

- `GET /api/regions`: the saved regions with metadata and cache-derived sizes.
- `POST /api/regions`: create by download (bbox, sourceIds, zoom range, name), returns the region and the
  job id; refuses upfront if over R.
- `DELETE /api/regions/:id`: delete (drop the join rows, unpin and evict the refcount-zero tiles, drop the
  entity).
- `GET /api/regions/:id/status`: the download progress.
- `GET /api/geocode?lat=&lon=`: the geocode proxy.
- `GET /api/cache/stats`: extended with the two-budget split.

## 9. The webapp: the prewarm panel becomes a Regions panel

The v2 prewarm panel evolves, reusing its infrastructure and primitives (`SlideOver`, `LayerToggle`,
`UnitField`, `.caps-label`, `.muted-note`, the existing list primitive, `createPrewarmRectangle`,
`detectCompanion`, `companionApiUrl`, and the companion API client extended with region methods):
- Draw the box (the reused panel-scoped Terra Draw rectangle), show the auto-selected deselectable
  covering raster sources, the zoom range, and a live estimate against regions-free.
- The editable geocoded name (filled on Download).
- Download runs the job with a progress bar; the region then joins a list (name, area, cache-derived
  size, last updated, re-download, delete) using the shared list primitive.
- A summary shows regions-used, scroll-used, and free within R (from the extended stats), so the bounded
  scroll cache is explained.
- Feature-detected (companion present) and write-token gated, consistent with the other panels.

## 10. Position-warm

Position-warm currently fires when the vessel is outside the single prewarmed box (`shouldWarm` and
`insideBox` over `config.bbox`). With the box gone, repoint it to "inside ANY saved region" via an
`insideAnyRegion(pos, regions)` over the regions list; keep the `positionWarm` settings block in
`prewarm.json`. Position-warm gets its own small reserved budget within the cache (a pseudo-region tag),
defined against R so it neither escapes nor starves the regions budget. A migration test covers
position-warm after the box-to-list migration.

## 11. Build order (for the implementation plan)

Four ordered, independently gated and reviewed tasks:
1. The region entity, the `prewarm.json` box-to-list migration, and the position-warm repoint.
2. The cache region-tile join table, per-region delete, the hard-reserved two-budget accounting, and the
   single SCHEMA_VERSION 3 bump.
3. The geocode container route and the plugin proxy.
4. The panel evolution from one box to a region list and editor, with the client-side enumeration and
   estimate.

## 12. Testing

- Region entity persistence and the box-to-list migration (including position-warm after migration).
- Enumeration includes global sources (no bounds) and bounds-intersecting sources, excludes the style
  basemap, via the `tileCountInBbox > 0` predicate; the estimate uses the `DEFAULT_TILE_BYTES` fallback.
- The download flow: the server-side refuse gate against R, warm and pin with the region tag, the status
  reconciliation (ready, capped, lost job), and re-download replacing the same region id.
- The cache: the join table and refcount (a tile shared by two regions survives deleting one), per-region
  delete unpins and evicts only refcount-zero tiles, the hard-reserved budgets (a region warm gates on
  `pinned_bytes + delta <= R`, the scroll cache is bounded at `cap - R`, a warm never evicts), and the
  pin-bytes accounting on a skip-but-pin.
- The geocode route: the host allowlist, the SSRF guards, the contactable User-Agent, lat/lon validation,
  and the coordinate fallback; geocoding fires once on Download, not on drag.
- The panel: draw to download, the estimate gate against regions-free, the editable name, the region list
  with cache-derived sizes, re-download, and delete; the stats split shown.

## 13. Decisions in force

- Region download is raster overlays only; the basemap region-warm and TTL eviction are deferred to their
  own sub-projects.
- The cache uses a region-tile join table with reference counting and a hard-reserved two-budget model
  (pinned regions within R, scroll within `cap - R`), one SCHEMA_VERSION 3 bump, with `needs-redownload`
  on the wipe.
- Enumeration and the estimate are client-side in the panel; the companion is the executor and gates
  authoritatively server-side.
- The geocoder is a dedicated container route to a single allowlisted host with a contactable User-Agent,
  fired only on the owner's Download action.
- The single-box prewarm is superseded by the regions list; position-warm is repointed to the list.
