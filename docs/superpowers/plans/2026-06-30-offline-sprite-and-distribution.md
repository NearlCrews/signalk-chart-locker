# Offline sprite and distribution prep: implementation plan

> For agentic workers: implement task by task, TDD, gates green per task. Steps use checkbox syntax.

**Goal:** Serve the basemap sprite from the cache so labels and icons render offline (4), and make
the repos publish-ready: rename the shared chart-sources package, rename and migrate the tile-cache
directory, and add a container-image push workflow (5). All publish steps are prep only; the user
runs the final npm publish and ghcr push.

**Architecture:** The Node plugin already proxies sprite subpaths to the container's cache-first
sprite handlers; the only gap is that the served style still carries the upstream-absolute sprite
URL. The plugin will rewrite that one field to an absolute same-origin proxy URL. Distribution work
is mechanical renames plus a one-time container-side cache-dir migration and a CI workflow.

**Tech stack:** TypeScript Node plugin (Express handlers), Rust tilecache container (axum, rusqlite),
GitHub Actions, npm, ghcr (buildx).

## Global constraints (verbatim from project rules)

- One npm package for the plugin; the container is a build artifact, not an npm package.
- The container stays tokenless and Signal K agnostic; only the in-process plugin talks to it.
- The runtime image carries no GDAL, GEOS, PROJ, or SpatiaLite.
- Units SI internally; convert only at a display edge.
- Writing rules for all code comments, commits, CHANGELOG, and docs: no em dashes, write "and" not
  "&", Oxford commas, "chartplotter" one word, no AI-process talk.
- Every task ends with its repo's gates green: plugin `npm run typecheck && npm run lint && npm test
  && npm run build`; Rust `cargo test --workspace && cargo clippy --workspace --all-targets -- -D
  warnings && cargo build --release --bin tilecache`.

---

## Part 4: Offline sprite

### Task 4.1: Plugin rewrites the style sprite to an absolute same-origin proxy URL

**Files:**
- Modify: `src/http/tile-routes.ts` (route registration `registerTileRoutes` at line 35; `GET
  /style/:source` is wired to the shared `proxy` at line 46; the `ProxyRequest`/`ProxyResponse`
  interfaces at lines 8-20)
- Modify: `src/plugin/plugin.ts:281` (the `registerTileRoutes(...)` call, to pass the public base)
- Modify: `src/shared/plugin-id.ts` consumer side (re-use `PLUGIN_ID` to build the base; do not import
  the runtime constant `PLUGIN_PUBLIC_BASE` into the transport module, per N3)
- Test: add cases to the existing `test/tile-routes.test.ts` (the file exists; do not create it)

**Interfaces:**
- Produces: `GET /style/:source` returns JSON with `sprite` replaced by
  `${proto}://${host}${publicBase}${stylePath}/sprite` (for example
  `http://<host>/plugins/signalk-chart-locker/style/basemap/sprite`), every other field unchanged.
  All other routes (`/style/:source/*`, `/tile/...`) keep streaming through `streamToContainer`.
- Consumes: container `GET /style/:source` (unchanged); the sprite subpaths are already proxied by the
  unchanged `GET /style/:source/*` route.

**Why:** MapLibre validates the `sprite` URL at style-parse time, before `transformRequest` runs, and
rejects a path-absolute `/plugins/...` value ("Invalid sprite URL, must be absolute"). The container
cannot emit an absolute URL (it knows only a path public-base, no scheme or host). The plugin injects
the request scheme and host. The webapp then sees a same-origin sprite URL whose path starts with
`/plugins/signalk-chart-locker/`, so the existing transformRequest (themed-map.ts:104) attaches the
bearer token, and the existing `/style/:source/*` proxy serves the cached sprite. After a basemap
region warm all four sprite variants are pinned under `__basemap_assets__` (warm.rs:325), so the
sprite, including @2x, renders offline.

**Design notes folded from review:**
- `ProxyRequest` is `{url, headers, on}` and `ProxyResponse` is `{status, setHeader, end(): void,
  headersSent}` (no `.get`, `.protocol`, `.type`, or `.send`). So: read forwarded headers off
  `req.headers`, widen `end(body?: string): void`, and add an optional `protocol?: string` to
  `ProxyRequest` (Express provides it at runtime) for the proto fallback. (M1.)
- Derive scheme defensively: `proto = firstToken(req.headers['x-forwarded-proto']) ?? req.protocol ??
  'http'`; `host = firstToken(req.headers['x-forwarded-host']) ?? asString(req.headers['host'])`.
  `firstToken` splits a comma-joined proxy chain and trims (N1). A TLS-terminating proxy that does not
  set `x-forwarded-proto` yields `http://` on an `https` page, which drops the token and mixed-content
  blocks the sprite; document that proxy requirement in the runbook (M4). Default LAN http is fine.
- `publicBase` is passed into `registerTileRoutes` as a parameter built from `PLUGIN_ID`
  (`/plugins/${PLUGIN_ID}`), not imported from the runtime config module (N3).
- Buffering and re-sending the style body drops upstream `etag`/`304`/range for the style JSON only.
  This is intentional: the body is host-dependent (cannot be statically ETagged) and tiny (about
  43 KB), and the streamed tile, glyph, and sprite paths keep range and conditional support. (Review
  question on 304/range.)

- [ ] Step 1: Add a failing test in `test/tile-routes.test.ts`: a stub container returns a style whose
  sprite is `https://tiles.openfreemap.org/sprites/ofm_f384/ofm`; `GET /style/basemap` (with header
  `host: boat.local:3000`) returns JSON whose `sprite` equals
  `http://boat.local:3000/plugins/signalk-chart-locker/style/basemap/sprite`, and whose `glyphs`,
  `sources`, and `layers` equal the upstream body. Add a second case: header
  `x-forwarded-proto: https` yields an `https://` sprite. Add a third: a non-2xx upstream status is
  forwarded unchanged with no parse.
- [ ] Step 2: Widen the interfaces (`end(body?: string): void`, optional `protocol?: string` on
  `ProxyRequest`) and add a `firstToken`/`asString` header helper.
- [ ] Step 3: Split `/style/:source` onto a dedicated `styleProxy(req, res, publicBase)` that fetches
  `http://${address}${req.url}` (forwarding the same `range`/`if-none-match` it does today is not
  needed here since we buffer), and on a 2xx JSON response parses the body, and if `typeof
  style.sprite === 'string'` sets `style.sprite =
  \`${proto}://${host}${publicBase}${req.url.split('?')[0]}/sprite\``, then
  `res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(style))`. On any non-2xx
  status, non-JSON content-type, parse error, or missing container address, fall back to the existing
  `streamToContainer` so behavior is unchanged. Keep `/style/:source/*` and `/tile/...` on the
  streaming `proxy`.
- [ ] Step 4: Thread `publicBase` through `registerTileRoutes(router, getAddress, publicBase,
  fetchImpl)` and pass `\`/plugins/${PLUGIN_ID}\`` from `plugin.ts:281`.
- [ ] Step 5: Run the tests; confirm pass. Run plugin gates (`npm run typecheck && npm run lint &&
  npm test && npm run build`).
- [ ] Step 6: Commit `fix(plugin): serve an absolute same-origin basemap sprite URL so it caches offline`.

### Task 4.2: End-to-end verification (manual, no code)

- [ ] Rebuild and redeploy the plugin, reload the webapp, confirm the sprite request goes to
  `/plugins/signalk-chart-locker/style/basemap/sprite.png` (same origin) and returns 200, and that
  `/cache/stats` still shows the sprite row. No commit.

---

## Part 5: Distribution prep

### Task 5.1: Rename the shared package to signalk-chart-sources

**Files:**
- Modify: `~/src/signalk-binnacle-chart-sources/package.json` (`name`)
- Rename dir: `~/src/signalk-binnacle-chart-sources` -> `~/src/signalk-chart-sources`
- Modify: `~/src/signalk-chart-locker/package.json` (the `file:` dep)
- Modify: `~/src/signalk-binnacle/package.json` (the `file:` dep)

- [ ] Step 1: `git mv` is not applicable across the dir at top level; rename the directory with `mv`,
  then in its `package.json` set `"name": "signalk-chart-sources"` (keep `"version": "0.1.0"`).
- [ ] Step 2: In both consumers change the dependency key from `signalk-binnacle-chart-sources` to
  `signalk-chart-sources` and the value to `file:../signalk-chart-sources` (keep file: for local dev;
  the publish runbook flips it to a version range).
- [ ] Step 3: Update every import specifier `signalk-binnacle-chart-sources` -> `signalk-chart-sources`
  across both consumer repos (grep first; update imports and any package-name string references).
- [ ] Step 4: `npm install` in chart-sources, chart-locker, and binnacle; run each repo's gates.
- [ ] Step 5: Commit in each repo: `refactor: rename the shared chart sources package to signalk-chart-sources`.

### Task 5.2: Rename and migrate the tile-cache directory, and rename the crate

**Files:**
- Modify: `src/runtime/tilecache-container.ts` (CACHE_DIR literal, line 16)
- Modify: `test/tilecache-container.test.ts` (assertions at lines 18 and 42)
- Modify: `container/tilecache/src/main.rs` (the startup sequence around lines 24-29: `create_dir_all`
  then `TileCache::open`)
- Modify: `container/tilecache/Cargo.toml` (the `[package] name`, line 2) and
  `container/Cargo.toml` if it names the member by package rather than path
- Test: a Rust unit test for the migration

**Why the crate rename:** the cache dir, the container name, and the plugin are all chart-locker
branded; only the crate package name `binnacle-tilecache` lags. The binary stays `tilecache` (the
`[[bin]]` name and `--bin tilecache` build are unaffected); only the package id changes. (Reviewer B.)

- [ ] Step 1: Change `CACHE_DIR` to `${SIGNALK_DATA_MOUNT}/chart-locker-tilecache`; update the two
  test assertions to the new path. Run the plugin gates.
- [ ] Step 2: Rename the crate: set `Cargo.toml` `[package] name = "chart-locker-tilecache"`. Grep the
  workspace for `binnacle-tilecache` (any `-p binnacle-tilecache`, workspace member spelled by name,
  or doc reference) and update. Run `cargo build` so `Cargo.lock` regenerates, then the full Rust gate.
- [ ] Step 3: Write a failing Rust test: given a parent dir containing only a legacy
  `binnacle-tilecache` subdir, `migrate_legacy_cache_dir(new_dir)` renames it to the new dir; given the
  new dir already present, it is a no-op and the legacy dir is left untouched; given neither, no-op.
- [ ] Step 4: Implement `migrate_legacy_cache_dir(cache_dir: &Path)`: if `cache_dir` does not exist and
  a sibling named `binnacle-tilecache` does, `std::fs::rename` legacy -> `cache_dir`. Call it in
  `main.rs` BEFORE the `create_dir_all(parent)` block (H1: `create_dir_all` would otherwise create the
  new dir first, making the "new dir absent" guard false and orphaning the legacy cache cold). On a
  skip-with-legacy-present or a rename error, log the legacy path at warn level so a cold start is
  recoverable rather than silent (L1). Legacy and new share the parent `/signalk-data`, so the rename
  is same-filesystem and atomic.
- [ ] Step 5: Run the Rust gate; confirm green.
- [ ] Step 6: Commit `feat(container): rename the crate and migrate the legacy tile-cache dir to chart-locker-tilecache`.

### Task 5.3: Container image push workflow (ghcr), prep only

**Files:**
- Create: `.github/workflows/container-image.yml`

- [ ] Step 1: Add a workflow triggered on `push: tags: ['v*']` and `workflow_dispatch`, with
  `permissions: { packages: write, contents: read }`, that runs in order:
  `docker/setup-qemu-action` (required: the Dockerfile compiles Rust inside the arm64 stage, so an
  amd64 runner needs QEMU or the arm64 `RUN` dies with `exec format error`, M2),
  `docker/setup-buildx-action`, `docker/login-action` against `ghcr.io` with `${{ github.actor }}`
  and `${{ secrets.GITHUB_TOKEN }}`, then `docker/build-push-action` with `context: container` and
  `file: container/tilecache/Dockerfile` (the default `{context}/Dockerfile` would be
  `container/Dockerfile`, which does not exist, M3), `platforms: linux/arm64,linux/amd64`, and tags
  `ghcr.io/${{ github.repository_owner }}/signalk-chart-locker-tilecache:latest` and the tag ref (N2).
  Set `provenance: false` so the manifest is a plain image podman can pull. BuildKit writes the
  Dockerfile `HEALTHCHECK` into the image config for both docker and OCI manifests, so it is preserved;
  note that at run time the plugin supplies the healthcheck through signalk-container
  (`makeContainerHealthcheck('/tilecache')`), so the baked one is belt-and-suspenders (L2).
- [ ] Step 2: `actionlint` the workflow if available; otherwise parse the YAML to validate. Do not push
  a tag or dispatch the workflow (prep only).
- [ ] Step 3: Commit `ci: build and push the tilecache image to ghcr on tag`.

### Task 5.4: Publish runbook

**Files:**
- Create: `docs/superpowers/2026-06-30-publish-runbook.md`

- [ ] Step 1: Document the exact ordered steps the user runs to publish: (1) `cd
  ~/src/signalk-chart-sources && npm publish --access public`; (2) in chart-locker and binnacle change
  the dep value from `file:../signalk-chart-sources` to `^0.1.0` and `npm install`; (3) push a `v*`
  tag (or dispatch `container-image.yml`) to publish the image; (4) the chart-locker npm publish path
  (existing release checklist). Include the exact ready-to-paste dep lines. Add a reverse-proxy note:
  a TLS-terminating proxy in front of Signal K must set `x-forwarded-proto: https`, or the basemap
  sprite URL is built as `http://` on an `https` page and mixed-content blocks it (M4).
- [ ] Step 2: Commit `docs: add the publish runbook for chart-sources, the image, and the plugin`.

---

## Self-review checklist

- Coverage: 4 (offline sprite) = 4.1 plus 4.2 verify. 5 (distribution) = 5.1 rename, 5.2 cache dir
  rename and migrate, 5.3 image push workflow, 5.4 runbook. All three named blockers covered.
- No placeholder steps; each shows the concrete change.
- The file: dep stays for local dev and is flipped in the runbook; this is the honest prep boundary
  since the version range cannot resolve until the user publishes.
