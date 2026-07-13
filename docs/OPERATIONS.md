# Operations

This guide covers the maintained operational behavior of Chart Locker. Historical implementation
plans under `docs/superpowers/` are not an operational reference.

## Runtime model

Chart Locker has two coordinated processes:

- The Node.js Signal K plugin owns configuration, saved-region metadata, PMTiles discovery and
  serving, the admin-gated management API, and browser-facing proxy routes.
- The Rust tile-cache container owns allowlisted upstream access, SQLite tile storage, eviction,
  warm jobs, vector-style assets, reverse geocoding, and cache statistics.

The plugin starts the container through `signalk-container`, resolves its private address, checks
health, and pushes the source allowlist and cache budgets. The internal container port should not be
published directly.

## Readiness states

The plugin panel and status line distinguish these conditions:

| State | Meaning | Operator action |
| ----- | ------- | --------------- |
| Container unavailable | No internal address was resolved | Check `signalk-container` and the Podman or Docker runtime |
| Startup health pending | The address exists, but the startup probe did not pass yet | Wait briefly, then inspect the container health and logs |
| Unconfigured | The service is running, but the source and budget push failed | Restart after the container is healthy and inspect `tilecache_config_push_failed` |
| Ready | SQLite is queryable and the configuration push succeeded | No action required |
| Disk pressure | The filesystem is below its protected headroom | Free disk space or reduce the cache cap |
| Slow upstream | A source recently timed out and is using an increased timeout | Cached stale tiles continue to serve; verify internet and provider health |

`GET /health` on the container returns `databaseReady` and `configured`. It returns HTTP 503 only
when the SQLite probe fails. It intentionally remains HTTP 200 before the first configuration push so
the container manager can declare the service started and allow the plugin to push configuration.

## Cache capacity and disk safety

The configured cap controls tile bytes tracked by SQLite. Saved-region tiles are pinned and exempt
from scroll-cache eviction. The saved-regions budget limits the pinned set, while unpinned scroll
tiles may use the remaining cache capacity.

The cache keeps at least 256 MiB of filesystem space outside new cache writes for SQLite WAL growth
and other host activity. When a write would consume that reserve:

- Live tile bytes are still returned to the requesting client.
- The tile is not stored.
- A disk-pressure counter is incremented.
- The panel reports the condition through cache statistics.

The safe clear action deletes only unpinned scroll rows. It does not remove saved-region tiles,
position-warm pins, or global basemap assets.

## Saved-region lifecycle

Region states are:

- `downloading`: a warm job is active.
- `ready`: every requested tile completed within the budget.
- `capped`: the warm reached a cache or pinned-byte limit.
- `error`: the job failed or disappeared.
- `needs-redownload`: durable metadata exists, but the cache no longer contains the region pins.

At plugin startup, a region left `downloading` is changed to `error` because warm jobs are in-memory
and cannot survive a container restart. The plugin also obtains all region byte totals in one request.
If a `ready` or `capped` region previously recorded bytes but now has no pinned bytes, it becomes
`needs-redownload`.

A re-download does not change the stored state until the container accepts the warm and returns a
non-empty job identifier. A rejected request therefore preserves the previous usable state. Deleting
a region removes container pins first and removes metadata only after that succeeds.

## Position warming

Position warming defaults to enabled with no selected sources, a 3,704 meter radius, a 1,852 meter
movement threshold, a 60 second interval, and base zoom 12. It performs no downloads until sources
are selected.

The server accepts these limits:

| Setting | Limit |
| ------- | ----- |
| Radius | 1 through 100,000 meters |
| Movement threshold | 0 through 100,000 meters |
| Interval | 60 through 86,400 seconds |
| Base zoom | Integer from 0 through 24 |
| Sources | Up to 64 unique, non-empty identifiers |

When the radius crosses longitude 180 or -180, the plugin sends two world-bounded boxes in one warm
job. This prevents the tile enumerator from treating the request as an almost-global box.

## Chart discovery

Chart discovery watches the configured directory and serializes every scan, including watch events,
manual rescans, and override reapplication. The panel reports:

- Valid chart count
- Invalid file count and validation errors
- Last completed scan time
- Manual Rescan charts action

Removed files and removed invalid archives are pruned on the next scan. The chart directory must stay
inside the Signal K configuration directory. PMTiles files are served only after discovery and their
real path is rechecked for containment at request time.

## Diagnostics

The panel reads these counters from `/api/cache/stats`:

| Counter | Meaning |
| ------- | ------- |
| `diskPressureEvents` | Writes declined because filesystem headroom was insufficient or SQLite reported a full disk |
| `warmRejections` | Warm requests rejected for an unknown source, invalid geometry, a tile limit, or a job limit |
| `configPushes` | Configuration pushes accepted by the container |
| `cacheOperationErrors` | Cache read, write, eviction, deletion, or management failures |

Relevant structured container events include:

- `event=config_push_applied`
- `event=warm_rejected`
- `event=cache_read_failed`
- `event=cache_write_failed`
- `event=cache_touch_failed`
- `event=cache_eviction_failed`
- `event=cache_region_delete_failed`
- `event=cache_database_recreating`
- `event=cache_database_recreated`

Plugin configuration-push events are `event=tilecache_config_push_succeeded` and
`event=tilecache_config_push_failed`.

## External cache storage

The external cache setting must be an absolute host path. The panel measures free space on that path
when it is available. If it cannot be measured, the response identifies the Signal K data filesystem
as the measurement fallback and shows a warning.

Before moving an existing cache, stop Signal K, copy the cache directory while preserving ownership,
configure the new absolute path, and start Signal K. The cache database is disposable, so starting
with an empty target is also safe. Saved-region metadata survives in the Signal K data directory and
missing pins are marked for re-download.

## Troubleshooting checklist

1. Read the plugin status and the warnings at the top of the configuration panel.
2. Confirm `signalk-container` is enabled and its runtime check passes.
3. Check container health for `databaseReady: true`.
4. Check cache statistics for `configured`, `diskPressure`, filesystem free bytes, and diagnostics.
5. Inspect structured events in the Signal K and container logs.
6. Use Refresh for cache statistics or Rescan charts for delayed filesystem events.
7. Re-download only regions marked `needs-redownload`, `error`, or `capped` when more coverage is
   required.

Do not delete `regions.json` to solve a cache problem. The cache database can be discarded, but
`regions.json` is the durable record of region definitions and position-warm settings.
