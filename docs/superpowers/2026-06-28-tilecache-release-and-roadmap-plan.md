# Tile cache release and roadmap plan

Date 2026-06-28. The single forward plan after tile cache v1 (raster and basemap proxy and cache)
and its hardening pass landed on `main` in all three repos. It covers the one remaining desk
verification, the ordered release sequence, the boat-only validation, the v1 deferrals, and the
next roadmap milestones.

## Current state (done, on main, green)

- `signalk-binnacle-companion` `main`: the Node plugin (M1), the Rust engine and router (M2), the
  offline geodata path (M3), the crows-nest cutover plumbing references, and now the `tilecache`
  container crate plus the plugin streaming proxy (tile cache v1). Container 25 tests, plugin 45
  tests, `clippy --workspace -D warnings` clean, release build of `router` and `tilecache` clean.
- `signalk-binnacle` `main`: the chartplotter routes its remote raster overlays and the vector
  basemap through the companion when present, with a direct-fetch fallback when absent. 1375 tests,
  svelte-check, `biome ci`, and the build green.
- `signalk-binnacle-chart-sources` `master`: the shared source registry and helpers. 14 tests.
- `signalk-crows-nest` `main`: the M4 companion-router cutover, version-bumped to 0.11.0, NOT yet
  tagged or published.

Everything below is either a desk verification, a release-gated step the owner runs, or a future
milestone. None of it is committed code waiting to merge.

## Step 1: the one remaining desk verification

The tilecache image Dockerfile (`container/tilecache/Dockerfile`, cmake in the builder for the
rustls crypto backend) has never been built; only the binary has. Build it and confirm the runtime
image carries no heavy native library:

```
podman build --format docker -t binnacle-tilecache container -f container/tilecache/Dockerfile
# confirm the runtime binary links only libc, libm, libgcc, and the loader (no GDAL, GEOS, PROJ):
podman run --rm --entrypoint /bin/sh binnacle-tilecache -c 'ldd /tilecache' 2>/dev/null \
  || (id=$(podman create binnacle-tilecache); podman cp "$id":/tilecache /tmp/tc && podman rm "$id"; ldd /tmp/tc)
# smoke the health subcommand and a /health serve on a scratch DB:
podman run --rm -e TILECACHE_DB=/tmp/tc.sqlite -p 18080:8080 binnacle-tilecache &
curl -s --max-time 3 http://127.0.0.1:18080/health   # expect {"status":"ok"}
```

`--format docker` is required or the HEALTHCHECK drops. The distroless runtime has no shell, so the
`ldd` check copies the binary out. If the build fails on cmake or the aws-lc-rs backend, that is the
bug to fix before any release.

## Step 2: the release sequence (owner-run, ordered)

Nothing reaches the boat until these run. Order matters: the package must exist before the consumers
can resolve it, and the images must exist before the plugin can pull them.

1. Publish the shared package. In `signalk-binnacle-chart-sources`: set a real version (start at
   0.1.0), `npm publish` (it has no dependencies and no build secrets). Then switch both consumers
   off the dev `file:` link to a version range:
   - `signalk-binnacle-companion`: `npm install signalk-binnacle-chart-sources@^0.1.0`.
   - `signalk-binnacle`: same.
   Commit each lockfile change. Until this is done, CI and fresh clones of the consumers cannot
   resolve the sibling, so their pipelines fail on install.
2. Build and push the container images to GHCR: the tilecache image (verified in step 1) and the
   router image if it is not already pushed. Tag to match `DEFAULT_TILECACHE_IMAGE` and
   `DEFAULT_ROUTER_IMAGE` in `src/runtime/*-container.ts`.
3. Release crows-nest 0.11.0. The M4 cutover is on `main`, version-bumped, but never tagged. Follow
   the SignalK plugin pre-push checklist: deps current, registry compliance, CI green on the
   published commit, then tag and let the publish workflow run. The branches I left are merged; this
   is the publish.
4. Release the companion plugin and the webapp when their own checklists pass. Both are unreleased.

## Step 3: boat-only validation (live server, container, internet)

These cannot run at the desk. Run them on the boat after the images are pushed:

1. The tilecache container launches under `signalk-container` (`ensureRunning` and
   `resolveContainerAddress` succeed), with the cache volume mounted and durable across an image
   update.
2. Two devices render the rasters and the basemap through the plugin route from one shared cache (one
   upstream fetch, two devices served).
3. With the internet pulled, the cached rasters and basemap still render offline.
4. A solo `signalk-binnacle` install with no companion still renders via direct fetch.
5. M4: a route draft on the boat routes through the companion when present and falls back to the
   in-process router when it is absent.

## v1 deferrals (documented, low priority)

These were left out of v1 deliberately; pick them up when they matter:

- NASA GIBS ocean fields fetch directly (they carry a `{date}`, so they need v2 daily re-push).
- The basemap sprite fetches directly (a small icon-set degradation; the geometry and glyphs are
  proxied).
- Glyph ranges are proxied but not persistently cached, so offline label text can degrade while the
  cached vector geometry still renders. Add a small blob cache if offline labels matter.
- Stale-tile revalidation is not single-flighted (the egress semaphore bounds the herd to 8). Coalesce
  it if a revalidation herd ever shows up.

## Next roadmap milestones (after v1 ships)

In priority order, each its own spec and plan:

1. v2 tile cache: prewarm a manual cruising bounding box, plus a throttled off-plan position-warm when
   the vessel leaves the box. Bounded writes for microSD. Builds on the v1 cache and proxy.
2. v3 tile cache: PMTiles ETag range-serving, so a remote PMTiles archive range-serves with strong
   ETags and the webapp `cache: 'no-store'` workaround retires. Most webapp coupling, least standalone
   gain, so it is last.
3. Tier-2: a boat-wide local time-series store with bundled SQLite, replacing the external QuestDB the
   dashboard depends on. See `docs/superpowers/roadmap/2026-06-27-cross-plugin-migration-candidates.md`.
4. M3 tail: run the prep pipeline over more NOAA ENC regions. Data-gated and operational, not code.

## Resume pointers

- Tile cache v1 build record and the hardening pass: `docs/superpowers/2026-06-27-tilecache-v1-progress.md`.
- v1 spec and plan: `docs/superpowers/specs/2026-06-27-tilecache-v1-raster-basemap-proxy-design.md`
  and `docs/superpowers/plans/2026-06-27-tilecache-v1.md`.
- The cross-plugin roadmap: `docs/superpowers/roadmap/2026-06-27-cross-plugin-migration-candidates.md`.
- The M3 geodata continuation: `docs/superpowers/2026-06-27-m3-handoff.md`.
