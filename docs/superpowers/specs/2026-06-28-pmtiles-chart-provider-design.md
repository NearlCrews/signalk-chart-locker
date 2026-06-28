# PMTiles chart provider (tile cache roadmap v3)

Design spec. Date 2026-06-28. Sub-milestone 3 of the boat-wide tile and chart cache and proxy roadmap
item (`docs/superpowers/roadmap/2026-06-27-cross-plugin-migration-candidates.md`, Tier 1 #1). It builds
on v1 (raster and basemap proxy and cache, on `main`) and v2 (prewarm box and position-warm, spec
written). The companion becomes a PMTiles chart provider, superseding the third-party
signalk-pmtiles-plugin, and the webapp retires its `cache: 'no-store'` workaround on the provided path.

This design was reviewed against correctness, the trust boundary, plan quality, and codebase fit before
finalizing, and every finding is folded in below. The review changed the architecture materially (see
the next section), so this spec reflects the restructured design, not the first draft.

## 1. The architecture decision (why no container)

The first draft put the PMTiles work in the egress container: a pure-Rust header decoder, a strong-ETag
Range server, and a boat-wide block cache, with the charts directory mounted read-only into the
container. The review rejected that on two independent grounds:

- It adds nothing for local files. A PMTiles archive served by signalk-pmtiles-plugin lives on the
  Signal K server host. The file on disk is already the durable, boat-wide store; a Range read is a local
  seek, not a network fetch; and the OS page cache holds hot ranges. A block cache of local bytes in
  SQLite is pure overhead and a coherence hazard. The per-browser-refetch pain (pain 10) is solved by a
  strong ETag re-enabling the browser HTTP cache, not by a second cache.
- It is not safely buildable. The conventional charts directory (`<configPath>/charts/pmtiles`) is not
  under `signalkDataMount` (which Signal K rewrites to the plugin-private data directory). The only
  deployment-robust mount that also works when Signal K itself runs in Docker is `signalkConfigRootMount`,
  which mounts the whole config tree, including `security.json` (the password hashes, the JWT secret, and
  device tokens). Putting that inside the one internet-facing, internet-egress, tokenless container is a
  direct violation of the trust rule in CLAUDE.md.

So the local PMTiles work lives in the Node plugin, which already runs in the Signal K process with
filesystem access and `app.config.configPath`. It adds no mount and no trust expansion. Range and
strong-ETag serving are straightforward in Node (`createReadStream(start, end)`, `Content-Range`,
`Accept-Ranges`, and an ETag from `fstat` size and mtime). Header decode uses the pure-JS `pmtiles` library
(the same one the third-party plugin uses server-side), awaited before publish. The egress container
stays exactly as v1 and v2 left it, remote upstreams only.

## 2. Goal

Make PMTiles charts intuitive and offline-correct: the companion discovers, decodes, validates, and
registers local `.pmtiles` charts itself, serves them with a strong ETag so the browser HTTP cache works
(retiring the webapp `cache: 'no-store'` workaround on the provided path), and offers a friendly chart
management panel. This supersedes the third-party signalk-pmtiles-plugin.

## 3. Third-party plugin pain points addressed

From signalk-pmtiles-plugin v1.2.2:
1. Weak ETag over Range (Express `res.sendFile` default `W/"size-mtime"`) triggers Chrome
   `ERR_CACHE_WRITE_FAILURE` on large archives, the bug the webapp `no-store` fights. Fixed by a strong
   ETag.
2. No live discovery: new files need a plugin disable and enable. Fixed by a debounced `fs.watch`.
3. Metadata race: `getMetadata` is unawaited, so charts can publish with bounds, zoom, and format
   undefined, showing the chart worldwide. Fixed by awaited synchronous decode before publish.
4. Metadata read over loopback HTTP to its own route. Fixed by decoding off disk in process.
5. No archive validation. Fixed by validating the magic, the version, and the tile type at ingest.
6. Hardcoded metadata (scale, description, name). Fixed by a per-chart override.
7. Thin config UX. Fixed by a management panel.
8. `stop()` leaks. Fixed by a clean `doStop` teardown.
Pain 9 (the Docker plus tippecanoe track generator) is out of scope. Pain 10 (no offline or
multi-device cache) is moot for local files: the strong ETag plus the local file gives offline and
multi-device serving without a second cache.

## 4. Locked decisions

- Local SK-server `.pmtiles` only. Remote URLs and blobs keep the webapp's current direct path. No
  open-URL proxy, no new egress.
- The plugin serves local archives; the container is untouched.
- The companion supersedes the third-party plugin via a real mutual exclusion (not a warning).
- The chart-resource id scheme is preserved (`nameToId`, `file.pmtiles` to `file-pmtiles`) so a cutover
  does not reset webapp state keyed by chart id (layer visibility, opacity, and ordering).
- The per-browser IndexedDB block cache is dropped on the provided path and kept as the fallback for
  non-provided archives (a blob, or no companion).

## 5. The plugin

### Discovery

- Watch a charts directory with a debounced `fs.watch` (default `<configPath>/charts/pmtiles`, the
  third-party default, so existing files work as a drop-in; configurable). New, changed, and removed
  files update the chart set without a plugin restart.
- Resolve each discovered file with `realpath` and confirm it is contained under the charts directory,
  rejecting a symlink or a path that escapes the directory. The id-to-file map is built only here, never
  from a client.

### Decode, validate, register

- Decode the PMTiles header and metadata off disk with the JS `pmtiles` library (`getHeader`,
  `getMetadata`), awaited before the chart is published, so bounds, minzoom, maxzoom, the tile type and
  format, and the `vector_layers` are always present (fixes the worldwide-bounds race).
- Validate the magic `PMTiles`, the spec version (3), and a known tile type; omit a degenerate or
  zero-area bounds box (the header packs lon and lat as int32 over 1e7, mirror `pmtiles-metadata.ts`).
  Surface a clear error in the plugin status for a corrupt or unknown-format archive rather than
  publishing it.
- Register the chart with the v1 `/signalk/v1/api/resources/charts` shape and the v2
  `registerResourceProvider({ type: 'charts' })` read path, using the preserved `nameToId` id and the
  decoded metadata. The chart resource `url` and `tilemapUrl` point at the plugin serve route in
  section 5 (Serve). Per-chart override of the name, the description, and the scale is persisted via the
  applicationData store.

### Serve

- A plugin HTTP route, `GET /plugins/signalk-binnacle-companion/pmtiles/:id`, serves the archive bytes:
  - A strong ETag minted from file identity (`st_size` and `st_mtime_ns`, or a full-file hash), never a
    hash of the 127-byte header. A re-exported archive whose header is byte-identical must still get a new
    ETag, or the browser HTTP cache and the pmtiles library serve stale bytes, the exact coherence bug
    this milestone must fix.
  - `Accept-Ranges: bytes`. A `Range` request with no conditional returns `206` with `Content-Range` via
    `createReadStream(start, end)`. An `If-Range` whose validator does not match returns the full `200`,
    never a `206` against a stale validator. An `If-None-Match` (no Range) that matches returns `304`. An
    unsatisfiable range returns `416`.
  - The route is open read-only (like the v1 tile and style routes); only the management and config
    routes are admin-gated (the gate ported in v2).

### Mutual exclusion and teardown

- If signalk-pmtiles-plugin is enabled, the companion does NOT also register charts (a real mutual
  exclusion), and surfaces the conflict in the plugin status with a clear instruction to disable the
  other plugin. Running both would otherwise show duplicate charts, because the Signal K resources read
  path merges all providers (`listFromAll` and `getFromAll`) and the two id schemes do not dedupe. Do
  not copy the third-party pattern of catching and debug-logging a failed registration; surface failures.
- `doStop` unwatches the directory, unregisters the resource provider, and clears the chart set.

## 6. The webapp (signalk-binnacle)

- Provided detection must be an EXACT match: the resolved absolute archive url equals the companion
  `/plugins/signalk-binnacle-companion/pmtiles/` path. A false positive that routes a blob or a remote
  weak-ETag archive through the provided path would reintroduce the Chrome cache bug. `createArchiveSource`
  today switches only on `startsWith('blob:')`.
- On the provided path, use a plain source with the default browser HTTP cache (the strong ETag makes the
  range-cache write succeed), retiring `cache: 'no-store'` and skipping the IndexedDB block cache. A
  non-provided archive (a blob, or no companion) keeps `NoStoreSource` and the IndexedDB block cache as
  the fallback.
- Tradeoff to document: dropping the IndexedDB block cache on the provided path means a device taken off
  the boat LAN (a phone ashore) loses PMTiles charts it had cached durably in the browser. On the boat it
  is unaffected, because the server serves the file.
- A chart-management panel, designed by the UI/UX team and consistent with the v2 prewarm panel (the same
  SlideOver shell, control primitives, design tokens, layout, and label voice): list the detected charts
  with their parsed header, the validation status, and a per-chart name and description. A browser upload
  of an archive is noted and deferred (large archives).

## 7. Phasing

- Phase A (the headless provider): discovery, decode and validate and register, the strong-ETag Range
  serve route, the mutual exclusion and teardown, and the webapp provided-path switch that retires
  `no-store`. This is fully functional without any new UI and fixes pains 1 through 5 and 8.
- Phase B (the management UX): the chart-management panel, the per-chart override, and the deferred
  upload. Fixes pains 6 and 7.

## 8. Trust and architecture rules (restated)

- The egress container is untouched and stays tokenless and remote-upstreams only. No charts mount, no
  config-tree exposure, no new container egress.
- The plugin serves local files from `app.config.configPath`, with a realpath containment check so a
  client id can never reach a file outside the charts directory.
- Allowlist-keyed by chart id, built only by the plugin from the discovered directory; an unknown id
  returns `404`; no client url reaches a fetch; there is no open-URL proxy.
- The plugin serves bytes; the webapp decides what is safe to show.
- Units are SI internally, converted only at the display edge per the server unit preference.

## 9. Dependencies and release

- Add the pure-JS `pmtiles` library to the companion plugin dependencies (the same library the
  third-party plugin uses; no native code).
- No shared `signalk-binnacle-chart-sources` change (provided detection is by url path, not by a shared
  id helper).
- Release per the SignalK plugin pre-push checklist: the CHANGELOG entries and the README "What's New"
  for the plugin and the webapp, and the version bumps. No container image rebuild is needed for v3 (the
  container is untouched).

## 10. Testing

- Plugin (node --test): the discovery watch (add, change, and remove, debounced), the realpath
  containment rejection of a symlink escape, the awaited decode and validate (a good archive, a corrupt
  one, an unknown tile type, and a degenerate bounds box), the registration with the preserved id and the
  decoded metadata, the per-chart override, the serve route (a strong file-identity ETag, `206` with
  `Content-Range`, an `If-Range` mismatch returning `200`, an `If-None-Match` returning `304`, and a
  `416`), the mutual exclusion when the third-party plugin is enabled, and the `doStop` teardown.
- Webapp (vitest): the exact provided-vs-direct detection, the provided path using the default cache and
  no `no-store` and no block cache, the non-provided fallback unchanged, and the management panel.

Boat-only: drop a `.pmtiles` in the charts directory and confirm it appears without a restart, renders
with correct bounds, caches in the browser, and renders offline with the internet pulled; confirm a
device ashore behaves per the documented tradeoff; confirm a solo `signalk-binnacle` install with no
companion is unaffected.

## 11. Decisions in force

- The local PMTiles provider lives in the Node plugin; the egress container is untouched. This is both
  the simpler design and the only one that keeps `security.json` out of the egress container.
- Local SK-server `.pmtiles` only; remote and blob archives keep the webapp's current direct path.
- The chart-resource id scheme is preserved so a cutover does not reset webapp layer state.
- Mutual exclusion with the third-party plugin is a real disable, surfaced in the plugin status, not a
  swallowed warning.
- The strong ETag is from file identity, never a header hash.
- The webapp provided-path detection is an exact url-path match.
- One spec, two phases (the headless provider, then the management UX).
