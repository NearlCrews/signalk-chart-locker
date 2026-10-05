# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<a id="v0100"></a>

## [0.10.0] - 2026-10-05

This release moves the configuration panel to `signalk-nearlcrews-ui` 0.13.0, rebuilds the tile
cache on Rust 1.99.0 over Debian 13, and corrects faults in the plugin and the container. The panel
compares edits with the configuration the Signal K Admin holds, announces each condition on its own,
reads sizes as words, and warns when its status readout goes stale. The plugin keeps a scroll-tile
retention changed since startup through every container recovery and restart, applies a
`signalk-pmtiles-plugin` toggle made during startup, and answers 503 rather than a misleading 409
while it is stopped. The container returns cleared space to the filesystem in large steps instead of
one page at a time, checks the control token before it reads a request body, and reports disk
pressure the way its write gate measures it. Every dependency, workflow action, and release tool is
current, and the full `npm audit` reports nothing. No configuration migration is required.

### Changed

- The configuration panel targets `signalk-nearlcrews-ui` 0.13.0 and follows its repainted sections,
  borders, tone glyphs, and Night theme. The three App Store screenshots are refreshed.
- The panel compares its edits with the configuration the Signal K Admin holds now, by value, instead
  of with a copy it kept. An edit undone by hand reads as no change, text is validated and saved
  trimmed the way the plugin reads it, and the configuration the Admin hands back after a save leaves
  the panel clean.
- A plugin nobody has configured opens with Save offered as the way to enable it, with the cache cap
  sized from the detected free space. A package that arrives with an empty configuration counts as
  configured.
- Each condition banner announces itself from a region mounted empty with the panel, replacing two
  combined announcers that reread every condition at once. Errors interrupt; the other conditions
  wait.
- The plugin status note reads "Checked N minutes ago" and turns into an "Out of date" warning with
  the warning mark once status polls stop succeeding for a minute.
- Byte sizes are read as words: the cache cap slider speaks "8 gibibytes" as its value, and the
  metrics, the per-source usage table, the free-space note, and the saved-regions budget read their
  unit names rather than spelling out GiB, MiB, or KiB.
- A maintenance button blocked while another action runs says what it is waiting for, and Apply
  retention says when the retention is already in force. Discard also drops a number box's text that
  is still being typed.
- Validation messages say how to fix the field, and a failed maintenance action names the action,
  such as "Applying the retention change failed: HTTP 503. Try again."
- The scroll-cache retention and saved-regions budget boxes are sized for the few digits they hold,
  matching the cache cap's exact-value box, rather than stretching across the row. A cache size in
  the per-source table stays on one line on a narrow panel, where the table scrolls instead.
- The panel build runs `snui-check-consumer` in runtime mode with the Webpack stats. It renders the
  built remote under the host's share scope with an absent and an empty configuration and checks the
  module graph, so the repository's own bundle script keeps only its package inventory and notices
  check. The browser suite loads the remote through the shared UI's host harness. The panel remote
  measures 53,729 gzip bytes, the new recorded baseline.
- An unavailable external cache path error includes `signalk-container`'s reason, which tells a
  missing path from one a containerized Signal K could not see.
- The recovery cooldown, the position-warm backoff, and the saved-region cache refresh measure
  intervals on a monotonic clock, so a system clock set from GPS after boot cannot stretch or skip
  them.
- Every PMTiles conflict message names `signalk-pmtiles-plugin`, the package an operator installs.
- The plugin loads the chart-source catalog through one shared loader and keeps one definition each
  of its manager-operation bound, its retry delays, and its saved-region and position-warm validation
  limits.
- The tile cache checks the control token before reading a request body, so an unauthenticated
  change is refused with 401 without parsing its payload.
- The tile cache refuses an upstream response whose declared length exceeds the body limit before
  downloading it.
- Egress no longer connects to the IPv6 IETF protocol assignment block (2001::/23), which includes
  Teredo and the benchmarking range.
- A large region download at the cache cap evicts scroll tiles to the same margin below the cap as
  live browsing, so it no longer rescans every scroll tile on each batch.
- Container log lines use the structured `event=` form throughout, and basemap download failures
  name the cache source rather than the upstream URL, which can carry a provider key.
- Development dependencies move to their current releases: Babel 8.0.6, the Signal K server API types
  2.33, `@types/node` 22.20.5, the Vite React plugin 6.1.2, cspell 10.3.6, knip 6.39, tsx 4.23.15,
  Vite 8.3.2, and webpack 5.111.1, with every transitive package refreshed inside its range. ESLint
  stays on 9.x because eslint-plugin-react and stable neostandard still declare an ESLint 9 peer, and
  `@types/node` stays on 22 to match the runtime floor.
- The Markdown linter calls the `markdownlint` library directly instead of running
  `markdownlint-cli2`, with the same rules over the same 13 maintained guides. The wrapper's glob
  stack carried an unpatched `braces` advisory, so the full `npm audit`, development dependencies
  included, now reports nothing at any severity. The `minimatch` and `smol-toml` overrides are gone,
  because ESLint's own range now floors at the patched `minimatch` 3.1.5 and nothing pins `smol-toml`
  once the wrapper is removed.
- The container builds on Rust 1.99.0 over Debian 13: the builder is `rust:1.99.0-trixie` and the
  runtime is `distroless/cc-debian13`, both digest pinned, because Debian 12 left regular security
  support in June 2026. `container/rust-toolchain.toml` and the toolchain inputs in the CI, container
  image, and publish workflows advance with them. Every Rust dependency is refreshed inside its range.
- The reusable Signal K plugin CI workflow moves to its 2026-10-04 master commit, which retires the
  armv7 lane upstream and replaces npm 10.9 on Node 22 runners, so the caller no longer passes the
  retired `enable-armv7` input.
- Workflow actions move to CodeQL 4.38.2, setup-qemu 4.4.0, setup-buildx 4.4.1, build-push 7.4.0,
  zizmor-action 0.6.4, and the Rust toolchain action's 2026-10-01 commit, which retries toolchain
  downloads that fail their checksum.
- Release tooling moves to Cosign 3.1.3, which fixes a signature verification bypass
  (GHSA-fx35-mq7g-6g98), Syft 1.52.0, npm 12.1.0 for trusted publishing, and cargo-about 0.9.2, which
  no longer discards detected license files. The image workflow names SPDX 2.3 explicitly, and
  `npm run ci:workflows` requires the image and publish workflows to agree on the Cosign release and
  the SBOM version, and every publish job to install the same npm client.
- `npm run check:package` and `npm run pack:release` start npm through the CLI path npm gives its
  scripts, so they also run on Windows. The notices generator works from a checkout path containing
  spaces, a stale Rust license report names its first differing line, the staging cleanup workflow
  grants package write access only to its job, and the package check leaves the shared UI
  dependency-field rule to the library's consumer check, which now enforces it.

### Fixed

- Host-side recovery restores the scroll-tile retention currently saved instead of the value from the
  plugin start, and the container waits for its first configuration before its first age sweep, so a
  retention raised or disabled from the panel survives both a recovery recreate and a container
  restart outside Chart Locker. Either sweep would otherwise remove scroll tiles the operator chose
  to keep.
- A scroll-tile retention saved while the tile cache is receiving its configuration now reaches the
  container last, so the container always applies the most recent save rather than keeping the
  older value that configuration carried until the next restart.
- Enabling or disabling `signalk-pmtiles-plugin` while the tile cache is starting is applied once
  startup finishes, instead of leaving both providers publishing the same charts, or neither, until
  the next restart.
- A stopped or starting Chart Locker answers PMTiles archive and chart-management requests with 503
  rather than a 409 blaming `signalk-pmtiles-plugin`, and its v1 chart routes pass the request on, so
  that plugin's own v1 routes keep answering after a live switch.
- A host-side recovery that leaves the container without a resolvable address is reported as a
  plugin error that names the cause and asks for a restart, since nothing is left to retry it. A more
  specific cause found during the recovery, such as a missing external cache drive, keeps its own
  remedy in the status instead.
- A saved-region bookkeeping write that fails at startup, for example on a full disk, is logged and
  retried at the next start instead of failing the whole start and stopping the tile cache and the
  PMTiles provider with it.
- A saved-region, cache, or geocode route that fails unexpectedly answers 500 instead of leaving the
  request open.
- The status line shows "Starting..." again after a stop during startup, rather than keeping the
  server's "Stopped".
- The style route reports a successful container response without a style document as 502, rather
  than relaying an empty success MapLibre cannot parse.
- Reverse geocoding refuses a repeated or nested `lat` or `lon` query value with 400 instead of
  forwarding its string form.
- A refused saved-region delete returns the container's explanation in the usual JSON error shape,
  and an unreachable container returns `{ "error": "tilecache unreachable" }`.
- Clearing the scroll cache or lowering the cache cap returns free space to the filesystem in 16 MiB
  steps. It previously returned one 4 KiB page per step, so a multi-gigabyte clear ran hundreds of
  thousands of WAL truncations.
- A legacy cached SVG or other active payload is no longer served as a stale tile while the upstream
  is unreachable.
- The cache statistics disk-pressure flag counts free pages inside the cache database, as the write
  gate does, so the panel no longer reports tiles going uncached while SQLite is still reusing space
  for them.
- A saved-region download that runs out of disk inside SQLite ends `capped` and keeps the previous
  pins instead of failing with a write error.
- A region download whose basemap glyphs and sprite exceed the saved-regions budget ends `capped`
  rather than `error`, and an already cached glyph range or sprite is measured against the same
  replacement allowance as a fetched one.
- Time-dynamic overlay tiles tell the browser only what remains of their source's freshness window,
  so a cached radar frame is no longer held for up to twice its declared lifetime.
- Glyph ranges and sprites answer a browser revalidation with 304 Not Modified instead of resending
  the whole asset.
- Upstream timeouts during a basemap download are tracked under the basemap's catalog id, so the
  slow source escalation reaches the live basemap routes and cache statistics no longer list internal
  cache keys as sources.
- Failed region deletions, warm writes, region promotions, staging cleanup, and scroll retention
  sweeps count toward `cacheOperationErrors` instead of only being logged.
- The panel's diagnostics line pluralizes each count ("1 cache error"), and the restart notice joins
  what it reapplies with a serial comma.
- A failure that already ended in a full stop, such as Firefox's network error, no longer reads with
  two.
- The empty charts hint names the saved directory the scan read rather than an unsaved edit, and the
  free-space note rounds to one decimal place like the metrics above it.

<a id="v090"></a>

## [0.9.0] - 2026-09-14

This release rebuilds the configuration panel on `signalk-nearlcrews-ui` 0.11.1, relabels several
of its controls, and corrects reporting and durability faults in the plugin. The panel takes its
frame, save bar, fields, table, and text from the shared library rather than from the local
components it carried, recovers in place when a render fails, and reads each field's unit with the
value instead of out of the label. The plugin keeps an actionable startup error in the status an
operator reads, keeps watching a charts directory that was rejected at start so a repaired one
serves without a restart, rescans only when that directory has actually changed, and never leaves
the saved regions without a readable file. No configuration migration is required.

### Added

- A render failure inside the panel now offers "Try again" and "Reload page" in place, so a
  transient failure is recoverable without the Signal K Admin host replacing the whole panel with
  its generic unavailable notice.
- The panel build ends with the shared UI package's own `snui-check-consumer`, which asserts the
  exact pin against the installed version, the version stamp in the built remote, the absence of a
  bundled React runtime, the published host share map, and gzip growth against the baseline recorded
  in `scripts/panel-size-baseline.json`.

### Changed

- The configuration panel targets `signalk-nearlcrews-ui` 0.11.1 and assembles its frame, save bar,
  number fields, text fields, freshness note, secondary text, and per-source usage table from the
  library's `PanelShell`, `SaveActionBar`, `NumberField`, `LabeledField`, `RelativeAge`, `Text`,
  `Code`, and `Table` primitives in place of the local components and wrappers it carried. The cache
  size cap row asks for its control widths under the renamed `controlWidth` prop, and the panel's
  own live regions carry a marker of their own, because the panel frame now mounts an announcer
  beside them.
- A save blocked by an invalid field refuses in place rather than going dark. Save keeps its place
  in the tab order, stays focusable, and names the field to fix on the status line beside it, so a
  keyboard or screen-reader operator is never left standing on a control that vanished.
- The save bar confirms a save with "Save sent to the server", and every field error leads with its
  tone word, read aloud and hidden on screen, so an error does not depend on color alone.
- The theme selector shows its "Panel theme" group label, names its two automatic choices "Match
  Admin" and "Match device", and says what Match Admin follows.
- The freshness notes beside the plugin status and the chart scan count in numbers from a day up, so
  an older reading is "1 day ago" rather than "yesterday".
- The scroll-cache retention, cache size cap, and saved-regions budget fields show their unit beside
  the input and read it with the value rather than carrying it in the label. The cache cap's slider
  and its exact-value box are both described by the GiB they measure.
- The cache-statistics loading line and the failure that can replace it share one live status
  region, now with a warning tone, so the failure is announced as an update to a region the reader
  already knows rather than as a new one.
- The panel's Module Federation share map is read from `signalk-nearlcrews-ui/federation` instead of
  being written out here, so the remote is built with the map the library was verified against. The
  repository's own bundle check keeps only what it alone knows: its dependency inventory, its React
  module allowlist, the production JSX runtime, the bundled attribution, and the render check.
- Night theme colors, the focus ring, heading sizes, and font weights follow the library's values,
  and the three App Store screenshots were recaptured against them. The panel remote measures 54,070
  gzip bytes, which the build now records as the baseline it checks growth against, in place of the
  fixed 40 KiB ceiling the previous release enforced over a bundle of about 37 KiB. The difference
  is the code the shared library added.
- The browser suite reads the version stamp and the theme storage key from the library's public
  entry point, which a CommonJS spec can now load directly, instead of re-reading both manifests and
  shelling out to a child process for the key.
- `signalk-container` is no longer declared as a peer dependency, so installing this plugin no
  longer installs a second plugin under it. The App Store still lists it as required, through the
  `signalk.requires` field it reads, and the manager contract the plugin uses is typed against the
  1.20.0 shape it has always assumed.
- A failed saved-region delete is logged as `event=cache_region_delete_failed` with the region
  identifier, so the region whose tiles stayed pinned can be identified from the container log.
- Dependabot proposes `signalk-nearlcrews-ui` updates in their own pull request, because the library
  ships breaking changes in 0.x minor releases and each one is reviewed against its migration guide.
- Development dependencies move to their latest releases: Playwright 1.63, webpack 5.111.0,
  webpack-cli 7.2.3, knip 6.35.1, cspell 10.3.1, Babel 8.0.5, tsx 4.23.13, Vite 8.3, the Vite React
  plugin 6.1.1, React and its types 19.3, and the Signal K server API types 2.32, with the
  `minimatch` override raised to 10.2.6 and `smol-toml` held at 1.8.0. No major version changed:
  ESLint stays on 9.x because eslint-plugin-react has not released ESLint 10 support and stable
  neostandard still declares an ESLint 9 peer, and `@types/node` stays on 22 to match the runtime
  floor, both as the repository's dependency update guide prescribes.
- The document linters and the spell checker read every maintained guide under `docs/`, not only the
  top level, and the reusable Signal K plugin CI workflow and the Rust toolchain action move to
  their current pins.
- The container builds on Rust 1.98.0. The pinned builder image, `container/rust-toolchain.toml`,
  and the toolchain inputs in the CI, container image, and publish workflows advance together, so
  one version describes both the compiler that produces the shipped binary and the one that formats,
  lints, tests, and audits it. The locked Rust dependency graph takes uuid 1.26.0, and the
  third-party license report was regenerated from it.
- The chart self-heal poll rescans when the charts directory changes identity or its containment
  verdict flips, and on every tick where no native watcher covers the directory. A rejected
  directory no longer pays a full safety check and a registry rebuild every five seconds to
  reproduce the error it already reported, and a repaired one still starts serving without a plugin
  restart.
- Durable state writes no longer list the whole Signal K data directory before staging their
  replacement. The temporaries that sweep reaps can only be left behind by a process killed
  mid-write, so it runs once per state file per process rather than on every saved-region edit.
- The plugin hands the server a status line only when it changes, rather than recomposing an
  identical line on each 30 second health probe.
- The configuration panel commits a new status timestamp only when the status itself changed or the
  freshness note beside it could have moved, so an idle panel no longer re-renders every five
  seconds.
- The container image tag field in the generated settings form carries the same length bound the
  plugin validates against, so it cannot accept a tag the plugin then rejects.
- A maintenance action that outlives its request budget reports the same words as the button that
  started it, so "Refreshing cache statistics" is still refreshing when the panel loses the answer.
- The tile-cache container reports the last of its prose log lines as `event=` key value pairs, and
  the operations guide lists them.

### Fixed

- A startup problem that names its remedy, a missing `signalk-container` or an external cache path
  that is not mounted, stays in the plugin status instead of being overwritten by the generic line
  that says tile caching is disabled. Signal K keeps one status slot per plugin, so the message is
  held and re-stated until the container is addressable.
- A server that exposes no admin middleware leaves the management API unmounted. The plugin now says
  so in its status instead of reporting a ready tile cache while every configuration panel request
  answers 404.
- A status written before chart discovery has answered no longer tells the operator to disable
  `signalk-pmtiles-plugin` on an install that never had it.
- A charts directory that was rejected at start is polled like any other, so replacing a symlinked
  path with a real directory starts serving the archives in it without a plugin restart. Previously
  that install kept no watcher and no poll, and served nothing until someone restarted the plugin.
- A tile-cache container adopted from the previous session is now owned by the plugin, so it is
  stopped at teardown rather than left running under its restart policy with nothing managing it,
  and an outstanding container transition is waited for rather than replaced, which could let an
  older cleanup stop the container a newer start had just launched.
- A chart startup that fails before the first container await, an unreadable overrides file for
  example, is reported instead of escaping as a process-level unhandled rejection.
- A failed chart rescan answers with a fixed message rather than the filesystem error, which carried
  absolute host paths to every caller. The detail goes to the plugin's debug log.
- A semantically corrupt saved-regions file is copied aside rather than moved, so a replacement that
  fails on a full or over-quota filesystem can no longer leave no regions file at all, which made
  the next start run on zero regions while their tiles stayed pinned in the container. Durable
  writes also reap the temporary files a hard kill leaves behind.
- A PMTiles provider update that fails while the plugin is running keeps its diagnosis in the status
  an operator reads. It was written straight to the shared status slot, so the next health probe
  replaced it with a healthy-looking line while the chart provider was still out of step with
  `signalk-pmtiles-plugin`.

### Removed

- The panel's CSS module and, with it, `css-loader` and `style-loader` from the panel toolchain and
  the bundled third-party notices.

<a id="v084"></a>

## [0.8.4] - 2026-08-22

This patch release refreshes the shared configuration panel, corrects the
declared Node.js floor, and replaces the hand-maintained bundled-dependency
attribution with a generated, gate-checked one. No configuration migration is
required.

### Added

- Third-party notices for the configuration panel are now generated from the
  packages webpack actually bundles, embed each license text, and are verified
  by the package gate, so an attribution gap fails the build instead of going
  unnoticed.
- A CodeQL analysis workflow covers the TypeScript plugin and panel sources.

### Changed

- The panel targets `signalk-nearlcrews-ui` 0.8.2, which settles the docked
  action bar within the frame that scheduled it, holds its docking decision
  through a hysteresis band, and no longer scrolls a control clear when a
  pointer press moves focus to it, so a control the bar overlaps takes its first
  click and stays under the pointer. Compact and icon-only buttons also meet the
  pointer target floor in width, and a revealed section re-reads the shared
  theme.
- The plugin CI workflow declares its test command and Node versions instead of
  inheriting them, and disables the armv7 lane, whose Node 20 runtime cannot
  install a package that requires Node 22.
- The mobile browser project runs the whole panel suite rather than only the
  coarse-pointer test.
- Touch and pointer target checking now covers every interactive control on
  every browser project, asserting the floor that applies to the pointer type
  and that each control is actually the topmost element where it would be
  pressed, rather than checking the height of three controls.
- App Store screenshots were regenerated, and the dark and night captures now
  render against a matching page instead of a light one.
- Compatible Rust container dependencies are refreshed, and the generated Rust
  license report matches the updated lock file.

### Fixed

- `engines.node` returns to `>=22.0.0`. The 0.8.3 line advertised a floor its
  own runtime dependencies never required, which told operators on Node 22.0
  through 22.21 that the plugin was unsupported when it runs there. Build-time
  tooling requirements now live in `devEngines` instead.
- The panel's advanced settings name reverse geocoding, matching the plugin
  schema and the documentation, rather than describing a place-name search that
  runs in the opposite direction.
- A request abandoned by a caller's own abort signal is no longer reported as
  though the panel had been torn down, and a request cut short by the panel's
  own teardown is no longer surfaced as a live failure, which could leave a
  stale status banner standing after an immediate remount.
- Cache usage per chart source shows thousands separators and sets source
  identifiers and rejected file names in a monospace face.
- Accept npm 12's singleton-array `npm view` output while rejecting ambiguous
  registry metadata, and verify the published `gitHead` and `dist.integrity`
  against the exact tested tarball. An explicit manual recovery dispatch now
  freezes an immutable tag revision, repeats every release gate against it,
  skips the privileged npm job, and verifies the already-published registry
  artifact without npm environment or OIDC access.

<a id="v083"></a>

## [0.8.3] - 2026-08-12

This patch release preserves learned vector-style state across offline
container restarts, refreshes the shared configuration panel, and strengthens
release verification. No configuration migration is required.

### Added

- The configuration panel now explains when its required native CSS scope
  support is unavailable.
- Documentation, spelling, workflow security, and dead-code checks now run as
  explicit local and CI quality gates.

### Changed

- The panel targets `signalk-nearlcrews-ui` 0.7.1, adds the System theme,
  docks save actions to the viewport when needed, consumes React and React DOM
  at the UI package's `^19.2.0` host range, and verifies that no other package
  enters the host share scope.
- Save and discard actions now report that the host request was issued and
  move focus to the stable completion message.
- Compatible dependencies and release workflows are refreshed. Release
  tarballs now verify their source commit through npm `gitHead` metadata.
- Panel screenshot capture now uses deterministic 1280 by 800 viewports.

### Fixed

- Persist learned vector-style documents, glyph and sprite templates, and expanded tile sources in
  SQLite. An unchanged catalog now rehydrates up to four styles during configuration, preserving the
  cache namespace of warmed assets so saved regions continue rendering after an offline container
  restart. Changed or removed style sources invalidate their stored metadata.
- Configuration saves preserve unknown top-level and grouped keys for
  forward-compatible round trips.

<a id="v081"></a>

## [0.8.1] - 2026-08-04

### Security

- Marked local PMTiles responses private so a shared intermediary cannot retain vessel-specific
  chart archives.
- Marked rewritten style documents `no-store` and stopped relaying upstream validators that do not
  describe the transformed, origin-specific response.

### Changed

- Updated `signalk-nearlcrews-ui` to 0.6.2, `signalk-chart-sources` to 0.7.2, and Node.js type
  declarations to the supported Node.js 22 line.
- Clarified the intentional legacy public-read fallback used when scoped Signal K plugin routers
  are unavailable, while preserving administrator-only management routes.
- Replaced package-relative README references with links that work from npm and removed a stale
  internal release-plan link.

<a id="v080"></a>

## [0.8.0] - 2026-08-02

### Added

- A saved region or automatic warm can select several map styles in one job, so the light and dark
  basemaps pin together for a night passage. One job accepts up to the four styles the container
  holds learned state for, and every selected style's glyphs and sprites stage and promote
  together.
- `GET /api/regions` reports `timeDynamicSourceIds` beside `unavailableSourceIds`, naming selected
  layers the catalog marks time-dynamic, so a region shows which of its layers are never stored
  offline.

### Changed

- Upgrade `signalk-chart-sources` to 0.7.0, adding twenty catalog sources: the OpenFreeMap Dark
  basemap, seven NOAA nowCOAST weather and ocean overlays, two GEBCO facets, EMODnet depth
  contours, four seabed-infrastructure overlays, monthly AIS vessel density, three more Marine
  Regions jurisdiction layers, and UNESCO World Heritage marine sites. Time-dynamic sources now
  declare `maxAgeSeconds`, and the tilecache honors it as a ceiling on the freshness window while
  refusing to warm those sources.
- Exclude time-dynamic weather and ocean layers from warming end to end. Region creation and the
  position-warm configuration refuse them with a 400 naming the offending sources before anything
  persists or reaches the container, the automatic warm filters them from saved selections instead
  of retrying a rejected job forever, startup drops them from persisted selections, and a region
  byte estimate no longer counts tiles the container will never store.
- Upgrade the configuration panel to `signalk-nearlcrews-ui` 0.6.1. The Advanced section uses the
  merged collapsible-section primitive, the footer action bar declares its bottom stickiness, cache
  metrics render value and unit through the metric unit slot, and the save-status indicator and
  status bar use the shared live-announcement prop rather than hand-wired attributes. A fresh
  panel follows the Auto theme rather than pinning Light, an unrecognized value on the shared
  theme key no longer resets a mounted panel, the legacy `cl-theme` key is no longer read, and
  panel styles use the published font and weight tokens.
- Relay a container 503 to the caller as 503 with the container's `Retry-After` preserved, and
  surface container control-token rejections and internal faults as 502 rather than the caller's
  own 401 or 500.
- Mirror the chart-sources 0.6 and 0.7 URL expansion changes in the tilecache: WMS base trailing
  slashes are stripped as ArcGIS already did, and BBOX ordinates snap projection-origin residue to
  zero, so the container and the package write byte-identical upstream requests.
- Raise the tilecache style-source capacity from one to four so the shipped light and dark basemaps
  fit one configuration push, and report configuration-push rejections with a named reason in both
  the container log and the 400 response body.
- Refresh the compatible npm, Rust, and browser toolchains. Add a Knip dead-code gate and a native
  coverage gate (90 percent lines, 80 percent branches, 90 percent functions) to CI and the release
  preflight, and share one Node test-suite definition between the test and coverage runners.
  In-range refreshes bring `signalk-container` 1.25.1 and `tsx` 4.23.4.

### Fixed

- A pinned saved-region tile stopped serving offline once it aged past the 30-day staleness bound,
  so a passage longer than a month lost its own downloaded charts, glyphs, and sprites. A pinned
  tile now serves for as long as it stays pinned when the upstream is unreachable.
- A time-dynamic tile could serve from the offline fallback for up to 30 days. The declared
  `maxAgeSeconds` now bounds every serving path, and a time-dynamic tile never receives the pinned
  exemption above.
- Deleting a region left its bytes counted as pinned forever, which could reject a later
  configuration push with a spurious 409 and cap subsequent region warms below their real budget.
- Match the container's URL validation to the chart-sources 0.7.0 boundary: ports, IP address
  literals, and loopback names are rejected in every URL field unless private egress is explicitly
  enabled for testing.
- A warm rejected for selecting only time-dynamic sources logged `invalid_geometry`; the log now
  names the real reason, matching the response body.
- Cache correctness details: a warm result of 204 no longer stores as 404, a stale cached vector
  style tile no longer serves as 404, paired byte-accounting statements run in a fixed order, and
  a source-validator prefix check strips a single occurrence.
- The panel's cache-statistics fallback paragraph no longer announces twice to screen readers.

<a id="v074"></a>

## [0.7.4] - 2026-07-28

### Changed

- Upgrade the configuration panel to `signalk-nearlcrews-ui` 0.4.1 and refresh the compatible npm
  toolchain, including React 19.2.8, webpack 5.109.1, and the TypeScript 7.0.2 native compiler.
  Type-aware JavaScript tooling retains the TypeScript 6 compiler API package until its ecosystem
  supports the native compiler API.
- Account for the shared UI upgrade and stricter response validation in the panel size budget. The
  production remote is 26,631 gzip bytes, and its reviewed growth gate is now 27 KiB.
- Align local, CI, release, and container builds on Rust 1.97.1; refresh the compatible Cargo lock;
  and update the pinned Rust builder, distroless runtime, checkout action, container registry login
  action, and Signal K plugin workflow revisions.
- Consolidate repeated record checks and configuration-path validation so the configuration panel
  and plugin enforce the same limits.

### Fixed

- Wait for a cache statistics poll that started before a mutation, then require a fresh read so a
  stale response cannot replace the newly saved scroll-retention or clear-cache state.
- Reject malformed cache statistics and chart-discovery responses without crashing the
  configuration panel.
- Preserve a caller-provided abort signal when applying panel request timeouts.
- Reject malformed plugin configuration roots and non-string container image tags with actionable
  errors instead of failing during startup.
- Limit configuration text fields to their server-side bounds and reject control characters before
  save.

<a id="v073"></a>

## [0.7.3] - 2026-07-27

### Fixed

- Accept fractional per-source tile averages from the cache statistics endpoint and round them up
  before saved-region budget estimation, instead of rejecting valid container statistics.
- Override ESLint's transitive `minimatch` dependency to the patched 10.2.5 release, clearing the
  development dependency audit without changing the published runtime dependency graph.

<a id="v072"></a>

## [0.7.2] - 2026-07-27

### Changed

- Upgrade `signalk-chart-sources` to 0.5.0 so NOAA ENC estimates and cache warming use the
  catalog-derived coverage regions instead of the service-wide display envelope.
- Align container source validation with the stricter shared contract for URL markers, template
  hosts and tokens, WMS query values, optional text, and controlled local HTTP fixtures.

### Fixed

- Count duplicate source identifiers once when estimating saved-region downloads.

<a id="v071"></a>

## [0.7.1] - 2026-07-25

### Fixed

- Tile requests over an HTTP/2 connection no longer lose part of a pan or zoom burst. Request
  admission was sized to the HTTP/1.1 same-origin connection limit and shed the excess with 503,
  which the chart renderer never retries, leaving permanent holes; over-burst requests now wait a
  bounded time for a free slot instead, without growing the container's retained-body budget.
- Browser-facing tile and style streams use a one minute proxy bound instead of the eight second
  control-plane bound. A cold viewport legitimately queues dozens of tiles behind the container's
  admission while slow WMS upstreams drain at the egress rate, and the fast bound aborted queued
  tiles that were about to serve. Health, configuration, statistics, and warming keep the fast
  bound, and the browser canceling a tile on pan or zoom still cancels the proxied fetch.

<a id="v070"></a>

## [0.7.0] - 2026-07-25

### Added

- Adopt a still-running, healthy, and configured tilecache from the previous session at plugin
  start, so browser tile requests serve immediately after a Signal K restart instead of answering
  503 until the container reconcile and configuration push complete.

### Fixed

- Serve raster style sources (the Liberty basemap's `ne2_shaded` shaded relief) through the style
  tile route as images. The vector-tile validator rejected their PNG bodies, so every shaded-relief
  tile answered 502 or 503 and was never cached, flooding the browser console on any chart that uses
  the proxied basemap.
- Require a configured external cache path and report a clear plugin error when it is unavailable
  instead of silently dropping the mount and falling back to the Signal K data directory.
- Detect a wedged host-side tilecache port, confirm that the service remains healthy inside the
  container, restart it with bounded and rate-limited recovery, re-resolve the published port, and
  restore the source and budget configuration before reporting readiness.

### Changed

- Refresh development dependencies (`@types/node` 26, `signalk-nearlcrews-ui` 0.3.0, React 19.2.8,
  webpack 5.109, Playwright 1.62, and the local `signalk-container` development copy at 1.23.2).
  ESLint stays on 9.x until `eslint-plugin-react` admits ESLint 10, and TypeScript stays on 6.x
  while the 7.0 compiler line settles.

<a id="v061"></a>

## [0.6.1] - 2026-07-18

### Changed

- Align local, CI, release, and container builds on Rust 1.97.0, and smoke-test the complete
  tile-cache image for pull requests that change its build inputs.
- Refresh locked `bytes`, `http-body`, `http-body-util`, and `tokio` dependencies, and
  regenerate the corresponding Rust license inventory.
- Upgrade `signalk-chart-sources` to 0.4.0 and align the Rust tile-cache boundary with its stricter
  source structure, URL, template, host, WMS, ArcGIS, and zero-longitude-span validation.

<a id="v060"></a>

## [0.6.0] - 2026-07-16

### Added

- Exercise the built configuration-panel remote in Chromium, Firefox, WebKit, and mobile Chromium,
  including save and discard behavior, field-linked validation, operational loading and failure
  states, keyboard and focus behavior, theme migration, destructive confirmation, Axe checks,
  320-pixel layouts, coarse-pointer targets, and the unsupported-browser message. The official
  Signal K integration jobs also start server 2.24.0 with signalk-container 1.20.0 and the latest of
  both, execute the real Admin application in Chrome, and mount the installed production panel
  remote. The release workflow repeats that real-host check using the exact tarball selected for npm.
- Build container images only after locked Rust tests, Clippy, RustSec checks, and the release-binary
  Node and Rust control contract pass. Both published architectures must become healthy and contain
  their license inventory before the version tag is attached. Tested images receive a keyless Cosign
  signature, GitHub build-provenance and per-architecture SPDX SBOM attestations, and downloadable
  amd64 and arm64 SBOMs.
- Generate and verify a complete third-party license report from the locked Rust runtime dependency
  graph. The report ships in both the npm package and tile-cache image.

### Changed

- Build the configuration panel on the accessible, theme-aware `signalk-nearlcrews-ui` 0.2.0
  primitives, migrate the former `cl-theme` preference into the shared theme key, replace the
  blocking scroll-cache confirmation with a focus-managed inline confirmation, and consume the core
  React singleton from the Signal K Admin Module Federation host. Signal K server 2.24.0 is now the
  minimum supported version because it provides the required React 19.2 Admin host by default.
- Embed the shared scoped design contract in each panel remote. Total production JavaScript grows
  from 16,474 to 25,014 gzip bytes while the consumer panel chunk shrinks; a 25 KiB build gate now
  prevents unreviewed growth. Webpack stats verify that core React comes from the host and that the
  shared UI library remains bundled.
- Require native CSS `@scope` support for the configuration panel. Supported browser floors are
  Chromium and Edge 118, Firefox 146, and Safari 17.4. Older engines receive a browser-update
  message instead of an unstyled panel.
- Publish the exact checksum-verified tarball produced by the complete release gates through npm
  trusted publishing. npm publication now verifies the matching image's architectures, source
  revision, healthcheck, signature, provenance, and SBOM before it can run. Stable packages use the
  `latest` dist-tag, while prereleases use `next`. Container promotion is serialized and refuses to
  move `latest` when a higher stable version tag exists. Weekly retention removes only old package
  versions whose tags are all abandoned run-scoped build tags.
- Align the Rust workspace MSRV, local toolchain, CI, and container builder on Rust 1.95.0, which is
  required by the locked SQLite binding's configuration macro.
- Make Nominatim region auto-naming optional through the Advanced geocoding control. Enabled lookups
  are globally limited to one request per second and cached in memory for 24 hours; disabling the
  control prevents coordinate egress without blocking saved-region downloads.
- Treat every image tag saved as a default by versions 0.1.0 through 0.5.0 as inherited during
  upgrade, so direct and skipped-version upgrades launch the matching 0.6.0 container. Other explicit
  development and custom image tags remain unchanged.

### Fixed

- Register tile, style, readiness, and PMTiles GET routes with Signal K's `readonly` access scope when
  the server supports scoped plugin routers, while retaining the secure administrator-only fallback
  on released servers without that API.
- Keep PMTiles discovery and serving inside the configured Signal K directory through symlinked path
  components, directory replacement, identifier collisions, file replacement during metadata reads,
  and path swaps after registration. Discovery coalesces event storms, cancels stale scans during
  shutdown, closes descriptors on stream failures and disconnects, and reports rescan errors instead
  of publishing stale chart metadata. Range and HEAD responses use identity-checked descriptors,
  strong ETags, bounded metadata, and `X-Content-Type-Options: nosniff`.
- Poll third-party PMTiles enablement on macOS and Windows instead of using native filesystem events,
  avoiding libuv watcher aborts while preserving live provider transitions.
- Make plugin lifecycle, mutual-exclusion transitions, persistent-state updates, container-manager
  calls, and every buffered container control response bounded and restart-safe. Startup and teardown
  are abortable, failed durable writes leave live state unchanged, corrupt state files are preserved
  for diagnosis, malformed state is normalized before use, and oversized, invalid UTF-8, malformed,
  or stalled control responses fail without partial state.
- Reject raw and percent-encoded traversal in tile and style proxy paths. Rewritten style documents
  are byte-bounded, and malformed or oversized upstream JSON fails without a partial response.
- Reconcile saved-region jobs in the background, including warm starts whose response was lost,
  terminal results that no browser polled, authoritative byte totals after replacement, bounded
  retries, and clean cancellation during stop. Rejected, capped, cancelled, or failed replacements
  preserve the last usable pins.
- Include `cachedBytes` in both normal and recovery-pending saved-region creation responses, matching
  the list response contract consumed by Binnacle.
- Apply cache-cap reductions and warm promotions coherently. A physical cap below pinned bytes is
  rejected without publishing candidate settings, eviction removes only eligible scroll data,
  cleared SQLite pages are returned to the filesystem, startup enforces the configured cap, and
  staged region plus basemap coverage is promoted only when every final budget fits.
- Convert v0.5.0 SQLite cache files to incremental auto-vacuum without deleting existing scroll
  tiles, pinned region coverage, or region membership. If disk pressure prevents the one-time
  preserving conversion, startup continues with the usable cache and retries on a later restart.
- Restrict repository-root container builds to the Rust workspace inputs and required license files,
  excluding local build output, dependencies, Git metadata, release artifacts, and scratch files.
- Bound container request admission, retained response bodies, background fills, warm fan-out, and
  single-flight keys while reserving independent health capacity. Shutdown now cancels and drains
  warm and fill work instead of abandoning in-flight cache mutations.

### Security

- Authenticate every mutating tile-cache route with a persistent random 32-byte control token that is
  created atomically, stored with mode 0600, passed only to the private container, and omitted from
  public APIs and logs.
- Validate upstream destinations at URL and DNS-connection time, disable redirects, and reject
  loopback, private, link-local, carrier-grade NAT, multicast, unspecified, transition-encoded, and
  other special-use IPv4 and IPv6 targets to close SSRF and DNS-rebinding paths.
- Run the digest-pinned distroless runtime as unprivileged UID and GID 65532 with only `/data`
  writable. Tile caching accepts only inert raster and vector-protobuf MIME types, so HTML, XML, SVG,
  and unsafe legacy cache entries are neither stored nor served as tiles.

<a id="v050"></a>

## [0.5.0] - 2026-07-13

### Changed

- Upgrade `signalk-chart-sources` to 0.3.1 and raise the supported Node.js floor to 22.
- Treat the shared chart-source catalog and geographic tuples as readonly, use the unit-specific
  `LngLatBbox` type, and carry disjoint source coverage into the tile-cache warm enumerator.
- Use source-specific and mode-specific first-download planning estimates from the shared catalog.

### Fixed

- Accept saved regions and PMTiles bounds that cross the antimeridian, detect positions inside those
  regions, and deduplicate overlapping warm coverage in the container.
- Reject unknown source identifiers and invalid estimate statistics with bounded client errors before
  a region is persisted or a warm begins.
- Keep PMTiles discovery and serving available when the container manager or runtime is unavailable,
  disable every PMTiles management and serving route during a provider conflict, create missing chart
  directories, recover failed directory watches, poll on platforms with unreliable watcher events,
  and detect same-size file replacements reliably.
- Serve PMTiles through a validated file descriptor identity so a path swap cannot redirect an
  in-progress request, and stream proxied responses with backpressure and cancellation handling.
- Download region replacements into job-specific staging pins, atomically promote only complete
  successful sets, preserve the last good region on every failed attempt, and serialize warm and
  delete operations for each logical region.
- Validate persisted region data, live positions, container configuration, statistics, and warm-job
  responses before they affect runtime state. Failed position warms now retry after backoff even when
  the vessel remains stationary, and warm-start requests are never replayed automatically.
- Restrict database recreation to confirmed SQLite corruption, reject invalid environment values,
  validate trusted source definitions and budget relationships, and report completed jobs with tile
  errors as failures instead of ready regions.

<a id="v044"></a>

## [0.4.4] - 2026-07-13

### Fixed

- The React 19 configuration panel now uses the production JSX runtime instead of failing to load
  when Babel 8 emits the unsupported development runtime.
- Startup migrates legacy cache limits that earlier releases accepted instead of rejecting the
  persisted configuration before the panel can open.
- Panel builds now fail if a future toolchain change emits the React development JSX runtime.

<a id="v043"></a>

## [0.4.3] - 2026-07-13

### Added

- Live cache operations in the plugin panel, including usage and disk headroom, per-source state,
  retention controls, scroll-cache clearing, diagnostics, chart discovery results, and manual rescans.
- Database-aware container health, batched saved-region byte totals, proactive filesystem headroom,
  and operator-facing failure counters.
- Antimeridian-aware position warming that covers both sides of the date line in one warm job.
- Readiness messages for container availability, startup health, and configuration-push state.
- Restart-impact guidance and inline configuration validation in the plugin panel.
- Structured operational events for cache failures, warm rejections, configuration pushes, and
  database recreation.
- Package-content verification that rejects stale retired modules before publication.

### Changed

- Cache free-space guidance now measures the configured external cache filesystem when it is
  available and explicitly reports a fallback to the Signal K data filesystem.
- Cache statistics compute per-source averages, bytes, and row counts in one grouped table scan.
- The saved-regions list obtains every region byte total through one container request instead of one
  request per region.
- The container healthcheck now performs an HTTP request and verifies SQLite instead of checking only
  whether the TCP port accepts a connection.
- Security and release documentation now use the current 0.4 support line and include the npm and
  Rust audit commands.

### Fixed

- Re-download failures now retain the prior region state and relay the container response instead of
  reporting a successful job with an invalid identifier.
- Saved regions whose cache pins disappear after database recreation are marked for re-download.
- Region, position-warm, chart override, and plugin configuration inputs now reject invalid values.
- State files are replaced atomically, deleted invalid charts no longer remain in discovery results,
  and chart rescans are serialized.
- Plugin builds clean `dist` before compilation, preventing retired modules from entering packages.
- Cache-retention and saved-region estimate requests now relay container failures instead of
  reporting success from rejected upstream operations.
- Warm responses are required to contain a non-empty job identifier before a region is marked as
  downloading.
- Saved-region names, coordinates, source identifiers, and zooms are validated against bounded
  server-side limits before container access.
- Position-warm settings now reject malformed booleans, distances, intervals, zooms, and source lists
  without changing persisted state.
- Chart overrides now reject empty names, oversized text, invalid scales, and bodies without a
  recognized field.
- Concurrent region-store mutations now share one synchronous read-modify-write path, preventing one
  update from overwriting another with a stale snapshot.
- The configuration panel disables Save while settings are invalid and reports missing cache
  readiness, disk pressure, and slow upstream sources.

### Security

- CI now audits production npm dependencies and the Rust lockfile. The security support table now
  identifies the current 0.4 release line.
- Direct plugin startup validates cache limits, chart-path containment, external-path form, and OCI
  image tags even when configuration bypasses the panel.

<a id="v042"></a>

## [0.4.2] - 2026-07-07

### Fixed

- **A recreated tilecache container could start with an empty tile allowlist.** `doStart` pushes
  the source allowlist and cache budget accounting to the container exactly once per plugin start,
  with no retry. A container recreated for a version bump can take a few seconds longer to start
  accepting connections than a warm restart (the first time a new image layer needs pulling), and a
  push that landed in that window failed outright, leaving every tile request 404ing and the
  regions and position-warm budgets at zero until the next restart happened to win the race.
  `pushTilecacheConfig` now retries a transient failure three times with linear backoff (1s, 2s)
  before giving up.

<a id="v041"></a>

## [0.4.1] - 2026-07-07

### Fixed

- **Seascape bathymetry tiles.** Bump `signalk-chart-sources` to 0.2.1, which adds the
  `seascape-dem` and `seascape-vector` catalog entries the Binnacle chartplotter's new bathymetry
  layer group needs. Every `/tile/seascape-dem/...` and `/tile/seascape-vector/...` request was
  404ing because the tilecache container's proxy allowlist had no entry for either id.

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

[Unreleased]: https://github.com/NearlCrews/signalk-chart-locker/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/NearlCrews/signalk-chart-locker/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/NearlCrews/signalk-chart-locker/compare/v0.8.4...v0.9.0
[0.8.4]: https://github.com/NearlCrews/signalk-chart-locker/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/NearlCrews/signalk-chart-locker/compare/v0.8.1...v0.8.3
