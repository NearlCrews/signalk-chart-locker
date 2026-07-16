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

Signal K servers with scoped plugin routers grant tile, style, readiness, and PMTiles GET routes to
authenticated `readonly`, `readwrite`, and administrator users. Released servers without that API
keep the fallback read routes inside the administrator-only plugin mount. Saved-region, cache,
reverse-geocoding, and chart-management routes remain administrator-only. On a secured server, use
`/skServer/loginStatus` to distinguish a signed-out browser, a non-administrator user, and an
administrator session before diagnosing an access failure.

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

Cache-cap configuration publication is transactional. The container validates irreducible pinned
bytes first, then evicts eligible scroll data, returns free SQLite pages to the filesystem, and
publishes the candidate settings only after enforcement succeeds. A cap below pinned saved coverage
is rejected before eviction. The prior container configuration remains active when one exists; a
fresh container whose retained database already exceeds its first requested cap remains
unconfigured. Increase the cap, or delete saved coverage and redownload only what fits, then retry
the lower cap. The plugin logs the rejection as `tilecache_config_push_failed` and reports the
container as unconfigured until a valid configuration push succeeds.

## Saved-region lifecycle

Region states are:

- `downloading`: a warm job is active or an accepted warm start is pending recovery by region ID.
- `ready`: every requested tile completed within the budget.
- `capped`: the warm reached a cache or pinned-byte limit.
- `error`: the job failed or disappeared.
- `needs-redownload`: durable metadata exists, but the cache no longer contains the region pins.

At plugin startup, the plugin looks up every region left `downloading` by region ID. A retained
running job resumes tracking, and a retained terminal job is reconciled into its durable state. The
region changes to `error` only when the container confirms that no retained job exists. The plugin
also obtains all region byte totals in one request. If a `ready` or `capped` region previously
recorded bytes but now has no pinned bytes, it becomes `needs-redownload`.

A deterministically rejected re-download leaves the stored state unchanged. Once the container
accepts the non-idempotent warm, the region becomes `downloading`. A well-formed response supplies the
job identifier immediately. If the accepted response is lost or malformed, the API returns recovery
pending and the reconciliation loop discovers the retained job by region ID. The container downloads
replacements into a temporary region and swaps the pins only after every tile succeeds and the final
set fits the budget. Rejected, capped, cancelled, or failed replacements therefore preserve the
previous usable pins. Only one warm may target a region at a time. Deleting a region first cancels and
drains its active warm, then removes container pins, and removes metadata only after that succeeds.

## Reverse-geocoding privacy and availability

The Advanced `geocodingEnabled` setting defaults to true. When enabled, region auto-naming sends the
region box center, rounded to five decimal places, to `nominatim.openstreetmap.org` only when a
download requests a name. It does not send the vessel position, credentials, Signal K data, or box
drag events. The container enforces one application-wide provider request per second and keeps a
24-hour, 256-entry in-memory response cache keyed by the rounded coordinates.

Disable the setting when no third-party coordinate disclosure is acceptable. Disabled geocoding
returns 404 without provider egress. DNS, connectivity, provider, and rate-limit failures do not block
the saved-region download; the chartplotter falls back to an editable coordinate-derived name. The
lookup cache is intentionally non-durable and is cleared by a container restart.

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

Chart discovery combines native directory events with a five-second file-identity poll on Linux, so
deleting and recreating the directory cannot strand a watcher on its old inode. Other platforms use
the five-second poll without a native watcher. Discovery serializes every scan, including change
detection, manual rescans, and override reapplication. The panel reports:

- Valid chart count
- Invalid file count and validation errors
- Last completed scan time
- Manual Rescan charts action

Removed files and removed invalid archives are pruned on the next scan. A failed directory watcher is
reported and retried. The chart directory must stay inside the Signal K configuration directory.
Discovery rejects symlinks outside that directory. PMTiles serving opens the discovered path, checks
the opened descriptor against the file identity captured during discovery, and streams from that
same descriptor so a path swap cannot redirect a request after validation. PMTiles discovery and
serving remain available when the tile-cache container or its runtime is unavailable.

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

An upgrade from 0.5.0 preserves existing cache rows and saved-region pin membership while converting
the SQLite file to incremental auto-vacuum. The conversion may temporarily need space for a second
database image. If SQLite reports a full disk, Chart Locker continues using the original cache,
logs `event=cache_auto_vacuum_deferred reason=disk_full`, and retries the conversion at the next
container start. Cleanup of abandoned staging pins is also deferred, with
`event=cache_staging_cleanup_deferred reason=auto_vacuum_disk_full`, so a second write cannot turn the
storage optimization fallback into a startup failure. Logical cache clears still complete in this
deferred state, although the database file cannot return free pages to the filesystem until
conversion succeeds.

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
