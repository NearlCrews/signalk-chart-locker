# HTTP API

Chart Locker routes are mounted below `/plugins/signalk-chart-locker`. This reference documents the
maintained plugin-facing API. The Rust container routes are private implementation details and should
not be exposed outside the Signal K host.

## Access control

Management routes under `/api` use the Signal K admin middleware. If the server cannot provide a
security strategy, Chart Locker fails closed and does not mount them.

The read-only tile, style, readiness, and PMTiles routes remain open so chartplotter clients can use
them through the normal Signal K HTTP origin. Tile source identifiers come from the trusted source
catalog, and PMTiles files must be present in the discovered registry.

## Browser-facing routes

| Method | Route | Purpose |
| ------ | ----- | ------- |
| GET | `/tiles/ready` | Returns 200 when a container address is available, otherwise 503 |
| GET | `/tile/:source/:z/:x/:y` | Streams a raster or vector tile through the cache |
| GET | `/style/:source` | Returns a cached vector style with its sprite URL rewritten to the same origin |
| GET | `/style/:source/*` | Streams style tiles, glyphs, and sprites |
| GET | `/pmtiles/:file` | Serves a discovered PMTiles archive with ETag, conditional request, and byte-range support |

## Cache management

| Method | Route | Request | Response |
| ------ | ----- | ------- | -------- |
| GET | `/api/cache-info` | None | Free GiB, recommended cap, measured storage, and fallback state |
| GET | `/api/cache/stats` | None | Cache totals, budgets, source state, readiness, filesystem state, diagnostics, and persisted `ttlDays` |
| POST | `/api/cache/config` | `{ "ttlDays": 0..365 }` | 204 after persistence and container acceptance |
| POST | `/api/cache/clear-scroll` | None | Container totals for freed rows and bytes |

`ttlDays` must be an integer. A value of 0 disables age-based removal. The setting is persisted before
the container call, so a 503 or 502 still leaves it ready for the next plugin start. A non-success
container response is relayed rather than converted to success.

Important cache-stat fields include:

```json
{
  "rows": 2480,
  "bytes": 734003200,
  "cap": 8589934592,
  "pinnedBytes": 314572800,
  "scrollBytes": 419430400,
  "regionsBudgetBytes": 4294967296,
  "regionsFreeBytes": 3980394496,
  "positionWarmBytes": 52428800,
  "availableBytes": 44560285696,
  "minimumHeadroomBytes": 268435456,
  "diskPressure": false,
  "configured": true,
  "ttlDays": 30,
  "bySource": [],
  "upstream": {},
  "diagnostics": {
    "diskPressureEvents": 0,
    "warmRejections": 0,
    "configPushes": 1,
    "cacheOperationErrors": 0
  }
}
```

## Saved regions

| Method | Route | Purpose |
| ------ | ----- | ------- |
| GET | `/api/regions` | Lists durable region metadata with current `cachedBytes` |
| POST | `/api/regions` | Validates, estimates, persists, and starts a region warm |
| GET | `/api/regions/:id/status` | Returns the active warm snapshot and reconciles terminal state |
| POST | `/api/regions/:id/redownload` | Replaces the region's pins with a new warm job |
| DELETE | `/api/regions/:id` | Removes container pins, then durable metadata |

Create request:

```json
{
  "name": "North Channel",
  "bbox": [-84.9, 45.7, -84.1, 46.2],
  "sourceIds": ["openstreetmap"],
  "minzoom": 6,
  "maxzoom": 14
}
```

Validation rules:

- `bbox` is `[minLongitude, minLatitude, maxLongitude, maxLatitude]`, finite, ordered, and within
  longitude -180 through 180 and latitude -90 through 90.
- `sourceIds` contains 1 through 64 unique, non-empty identifiers, each no longer than 256 characters.
- Zooms are integers from 0 through 24, and `minzoom` cannot exceed `maxzoom`.
- The trimmed name contains 1 through 120 characters.
- The server estimate must fit `regionsFreeBytes` before the region is persisted.

A successful create response contains `{ "region": ..., "jobId": "..." }`. A successful re-download
contains `{ "jobId": "..." }`. The plugin does not mark a re-download active until the container
returns success with a non-empty identifier.

## Position warming

| Method | Route | Purpose |
| ------ | ----- | ------- |
| GET | `/api/position-warm/config` | Returns the current position-warm settings |
| POST | `/api/position-warm/config` | Merges a validated `positionWarm` patch without changing regions |

Example patch:

```json
{
  "positionWarm": {
    "enabled": true,
    "radiusMeters": 3704,
    "moveThresholdMeters": 1852,
    "intervalSecs": 60,
    "baseZoom": 12,
    "sources": ["openstreetmap"]
  }
}
```

Limits are documented in the [operations guide](OPERATIONS.md#position-warming). Unknown fields are
ignored, but every recognized field that is supplied must have the documented type and range.

## Chart management

| Method | Route | Purpose |
| ------ | ----- | ------- |
| GET | `/api/charts` | Lists valid charts, stored overrides, invalid archives, and discovery status |
| POST | `/api/charts/rescan` | Waits for a serialized discovery scan and returns its status |
| POST | `/api/charts/:id/override` | Merges validated display metadata for a known chart |

Override bodies may contain:

- `name`: trimmed, 1 through 120 characters
- `description`: trimmed, up to 1,000 characters
- `scale`: finite, positive, and no greater than `Number.MAX_SAFE_INTEGER`

At least one recognized field is required. A successful override is persisted immediately, and its
rescan is queued without delaying the response. Use `/api/charts/rescan` when the caller must wait for
the completed discovery result.

## Reverse geocoding

`GET /api/geocode?lat=<latitude>&lon=<longitude>` relays a guarded request through the container to
the allowlisted Nominatim service. Both query parameters are required. The endpoint sends only the
coordinates needed to name a region.

## Common error statuses

| Status | Meaning |
| ------ | ------- |
| 400 | Malformed input, invalid bounds, invalid zooms, or a region estimate above budget |
| 404 | Unknown chart, region, source, or warm job |
| 429 | The container warm-job limit is active |
| 502 | The container request failed or returned an invalid response |
| 503 | The container address or required internal service is unavailable |
