/** The admin-gated tile, region, and geocode routes. They persist the position-warm settings
 * and the saved regions through the regions store, and forward warm and cache operations to the tilecache
 * container. Mounted only when the admin gate holds, so an ungatable server leaves them unmounted (fail closed). */

import { randomUUID } from 'node:crypto'
import type { ServerAPI } from '@signalk/server-api'
import type { ChartSource, LngLatBbox } from 'signalk-chart-sources'
import { ensureApiAdminGate } from '../shared/admin-gate.js'
import { CONTAINER_FETCH_TIMEOUT_MS } from '../runtime/container-fetch.js'
import {
  loadRegionsStore, mutateRegionsStore, type PositionWarmSettings,
  addRegion, updateRegion, removeRegion, listRegions,
  type SavedRegion, type RegionStatus
} from '../runtime/regions-store.js'
import { nowUnixSecs } from '../shared/time.js'

// The plugin compiles to CommonJS, while chart-sources 0.3.x exposes an ESM-only runtime.
const chartSources = import('signalk-chart-sources')

export interface RegionsRequest {
  params: Record<string, string>
  body: unknown
  query?: Record<string, string>
}

export interface RegionsResponse {
  status (code: number): RegionsResponse
  json (value: unknown): void
  end (): void
}

export interface RegionsRouter {
  get (path: string, handler: (req: RegionsRequest, res: RegionsResponse) => void | Promise<void>): void
  post (path: string, handler: (req: RegionsRequest, res: RegionsResponse) => void | Promise<void>): void
  delete (path: string, handler: (req: RegionsRequest, res: RegionsResponse) => void | Promise<void>): void
}

/** A terminal-or-running warm job snapshot, as the container reports it from GET /warm/:jobId. */
interface WarmSnapshot {
  total: number
  done: number
  skipped: number
  bytes: number
  errors: number
  state: 'running' | 'done' | 'cancelled' | 'capped' | 'error'
}

/** Stats the budget re-validation reads from the container. */
interface ContainerStats {
  regionsFreeBytes?: number
  perSourceAvgBytes?: Record<string, number>
}

type FetchImpl = (url: string, init?: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }) => Promise<Response>

interface Deps {
  dataDir?: string
  fetchImpl?: FetchImpl
}

/** The floor for the position-warm interval, enforced server-side as well as in the panel. */
const MIN_WARM_INTERVAL_SECS = 60
const MAX_WARM_INTERVAL_SECS = 86_400
const MAX_WARM_DISTANCE_METERS = 100_000
const MAX_SOURCE_IDS = 64
const MAX_SOURCE_ID_LENGTH = 256
const MAX_REGION_NAME_LENGTH = 120
const MAX_WARM_ZOOM = 24

// Container route bases reached from more than one handler, named so each path lives once. Single-use
// routes (scroll-ttl, clear-scroll, and geocode) stay inline at their one call site.
const CONTAINER_STATS_PATH = '/cache/stats'
const CONTAINER_REGION_PATH = '/cache/region'
const CONTAINER_REGIONS_PATH = '/cache/regions'
const CONTAINER_WARM_PATH = '/warm'

/** A finite lon/lat bbox. West greater than east means the box crosses the antimeridian. */
function isValidBbox (value: unknown): value is LngLatBbox {
  return Array.isArray(value) && value.length === 4 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    value[0] >= -180 && value[0] <= 180 && value[2] >= -180 && value[2] <= 180 &&
    value[1] >= -90 && value[1] <= 90 && value[3] >= -90 && value[3] <= 90 &&
    value[0] !== value[2] && !(value[0] > value[2] && Math.abs(value[0] - value[2]) === 360) && value[1] < value[3]
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonnegativeFinite (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonnegativeInteger (value: unknown): value is number {
  return isNonnegativeFinite(value) && Number.isSafeInteger(value)
}

function readContainerStats (value: unknown): ContainerStats | undefined {
  if (!isRecord(value) || !isNonnegativeInteger(value.regionsFreeBytes)) return undefined
  const averages: Record<string, number> = {}
  if (value.perSourceAvgBytes !== undefined) {
    if (!isRecord(value.perSourceAvgBytes)) return undefined
    for (const [source, bytes] of Object.entries(value.perSourceAvgBytes)) {
      if (!isNonnegativeInteger(bytes) || bytes === 0) return undefined
      averages[source] = bytes
    }
  }
  return { regionsFreeBytes: value.regionsFreeBytes, perSourceAvgBytes: averages }
}

const WARM_STATES = new Set<WarmSnapshot['state']>(['running', 'done', 'cancelled', 'capped', 'error'])

function isWarmSnapshot (value: unknown): value is WarmSnapshot {
  if (!isRecord(value) || typeof value.state !== 'string' || !WARM_STATES.has(value.state as WarmSnapshot['state'])) return false
  const { total, done, skipped, bytes, errors } = value
  if (!isNonnegativeInteger(total) || !isNonnegativeInteger(done) || !isNonnegativeInteger(skipped) ||
      !isNonnegativeInteger(bytes) || !isNonnegativeInteger(errors)) return false
  return value.state !== 'done' || errors !== 0 || done + skipped === total
}

function validSourceIds (value: unknown, allowEmpty: boolean, sourceById: (id: string) => ChartSource | undefined): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_IDS || (!allowEmpty && value.length === 0)) return false
  if (!value.every((source) => typeof source === 'string' && source.length > 0 && source.length <= MAX_SOURCE_ID_LENGTH)) return false
  return new Set(value).size === value.length && value.every((source) => sourceById(source) !== undefined)
}

function readPositionWarmPatch (value: unknown, sourceById: (id: string) => ChartSource | undefined): Partial<PositionWarmSettings> | string {
  if (!isRecord(value)) return 'positionWarm must be an object'
  const patch: Partial<PositionWarmSettings> = {}
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') return 'enabled must be a boolean'
    patch.enabled = value.enabled
  }
  for (const [key, min, max] of [
    ['radiusMeters', 1, MAX_WARM_DISTANCE_METERS],
    ['moveThresholdMeters', 0, MAX_WARM_DISTANCE_METERS],
    ['intervalSecs', MIN_WARM_INTERVAL_SECS, MAX_WARM_INTERVAL_SECS]
  ] as const) {
    if (key in value) {
      const candidate = value[key]
      if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < min || candidate > max) {
        return `${key} must be a finite number between ${min} and ${max}`
      }
      patch[key] = candidate
    }
  }
  if ('baseZoom' in value) {
    if (typeof value.baseZoom !== 'number' || !Number.isInteger(value.baseZoom) || value.baseZoom < 0 || value.baseZoom > MAX_WARM_ZOOM) {
      return `baseZoom must be an integer between 0 and ${MAX_WARM_ZOOM}`
    }
    patch.baseZoom = value.baseZoom
  }
  if ('sources' in value) {
    if (!validSourceIds(value.sources, true, sourceById)) return 'sources must be a unique array of valid source IDs'
    patch.sources = value.sources
  }
  return patch
}

/** Mount the regions routes behind the admin gate. Returns whether they were mounted. */
export function registerRegionsRoutes (router: RegionsRouter, app: ServerAPI, getAddress: () => string | null, deps: Deps = {}): boolean {
  if (!ensureApiAdminGate(app)) return false
  const dataDir = deps.dataDir ?? app.getDataDirPath()
  const rawFetch: FetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  // Wrap every container fetch with a bounded timeout, so a hung container endpoint (for example a
  // deadlocked /cache/stats) surfaces as a caught failure and a 502 or 503, never an open request that
  // hangs the panel. A caller that supplies its own signal keeps it.
  const fetchImpl: FetchImpl = (url, init) => rawFetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)
  })

  const withAddress = (res: RegionsResponse): string | null => {
    const address = getAddress()
    if (address === null) {
      // Match the JSON error shape every other failure path in this file uses, rather than a bare body.
      res.status(503).json({ error: 'tilecache unavailable' })
      return null
    }
    return address
  }

  const relay = async (res: RegionsResponse, upstream: Promise<Response>): Promise<void> => {
    try {
      const r = await upstream
      const body = await r.json().catch(() => ({}))
      res.status(r.status).json(body)
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  }

  // The latest warm job per region, set on POST and redownload. In-memory: it does not survive a plugin
  // restart, so the status route and the startup sweep treat a missing job for a downloading region as
  // a lost job and reconcile it to error.
  const regionJobs = new Map<string, string>()

  const warmInit = (body: unknown): { method: string, headers: Record<string, string>, body: string } => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  // Best-effort container region_bytes; falls back to the supplied default when unreachable.
  const regionBytes = async (address: string, regionId: string, fallback: number): Promise<number> => {
    try {
      const r = await fetchImpl(`http://${address}${CONTAINER_REGION_PATH}/${encodeURIComponent(regionId)}`)
      if (!r.ok) return fallback
      const data = (await r.json()) as { bytes?: number }
      return isNonnegativeInteger(data.bytes) ? data.bytes : fallback
    } catch {
      return fallback
    }
  }

  const allRegionBytes = async (address: string): Promise<Record<string, number> | null> => {
    try {
      const response = await fetchImpl(`http://${address}${CONTAINER_REGIONS_PATH}`)
      if (!response.ok) return null
      const body = (await response.json()) as { regions?: unknown }
      if (!isRecord(body.regions)) return null
      const totals: Record<string, number> = {}
      for (const [id, bytes] of Object.entries(body.regions)) {
        if (!isNonnegativeInteger(bytes)) return null
        totals[id] = bytes
      }
      return totals
    } catch {
      return null
    }
  }

  const statusFromSnapshot = (snapshot: WarmSnapshot): RegionStatus => {
    if (snapshot.state === 'done' && snapshot.errors === 0) return 'ready'
    if (snapshot.state === 'capped') return 'capped'
    return 'error'
  }

  // Map a terminal warm snapshot to the persisted region status. A running snapshot leaves the region
  // untouched. A terminal snapshot writes status, lastDownloadedAt, and the container region_bytes.
  const reconcile = async (address: string, regionId: string, snapshot: WarmSnapshot): Promise<void> => {
    if (snapshot.state === 'running') return
    const bytes = await regionBytes(address, regionId, snapshot.bytes)
    updateRegion(dataDir, regionId, {
      status: statusFromSnapshot(snapshot),
      lastDownloadedAt: nowUnixSecs(),
      bytes
    })
  }

  // A region whose job is gone (unknown id or a 404 from the container) must not stay downloading.
  const reconcileLostJob = (regionId: string): void => {
    const region = listRegions(dataDir).find((r) => r.id === regionId)
    if (region && region.status === 'downloading') {
      updateRegion(dataDir, regionId, { status: 'error' })
    }
  }

  // The position-warm settings live in the regions store. GET returns just the positionWarm block and
  // POST merges ONLY the incoming positionWarm, preserving the saved regions, so saving settings never
  // drops a region.
  router.get('/api/position-warm/config', (_req, res) => {
    res.status(200).json(loadRegionsStore(dataDir).positionWarm)
  })

  router.post('/api/position-warm/config', async (req, res) => {
    if (!isRecord(req.body) || !('positionWarm' in req.body)) {
      res.status(400).json({ error: 'positionWarm is required' }); return
    }
    const { chartSourceById } = await chartSources
    const patch = readPositionWarmPatch(req.body.positionWarm, chartSourceById)
    if (typeof patch === 'string') { res.status(400).json({ error: patch }); return }
    mutateRegionsStore(dataDir, (store) => {
      store.positionWarm = { ...store.positionWarm, ...patch }
    })
    res.status(204).end()
  })

  router.post('/api/cache/config', async (req, res) => {
    const ttlDays = (req.body as { ttlDays?: unknown } | undefined)?.ttlDays
    if (typeof ttlDays !== 'number' || !Number.isInteger(ttlDays) || ttlDays < 0 || ttlDays > 365) {
      res.status(400).json({ error: 'ttlDays must be an integer between 0 and 365' }); return
    }
    // Persist to the store first, the source of truth, so the new TTL survives even when the container
    // is down: it is pushed on the next doStart. With no address this returns 503 after persisting,
    // which is intended.
    mutateRegionsStore(dataDir, (store) => { store.cacheScrollTtlDays = ttlDays })
    const address = withAddress(res); if (address === null) return
    try {
      const upstream = await fetchImpl(`http://${address}/cache/scroll-ttl`, warmInit({ ttlSecs: ttlDays * 86_400 }))
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: 'tilecache rejected cache configuration' }); return
      }
      res.status(204).end()
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  })

  router.post('/api/cache/clear-scroll', async (_req, res) => {
    const address = withAddress(res); if (address === null) return
    return relay(res, fetchImpl(`http://${address}/cache/clear-scroll`, { method: 'POST' }))
  })

  router.get('/api/cache/stats', async (_req, res) => {
    const address = withAddress(res); if (address === null) return
    // Not a pure relay: the container stats are merged with ttlDays from the store (the plugin owns the
    // TTL persistence), so the panel reads the TTL and the cache breakdown in one round-trip.
    try {
      const r = await fetchImpl(`http://${address}${CONTAINER_STATS_PATH}`)
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>
      const ttlDays = loadRegionsStore(dataDir).cacheScrollTtlDays
      res.status(r.status).json({ ...body, ttlDays })
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  })

  router.get('/api/geocode', async (req, res) => {
    const address = withAddress(res); if (address === null) return
    const query = (req.query ?? {})
    const { lat, lon } = query
    if (!lat || !lon) { res.status(400).json({ error: 'lat and lon are required' }); return }
    return relay(res, fetchImpl(`http://${address}/geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`))
  })

  router.get('/api/regions', async (_req, res) => {
    const address = getAddress()
    const regions = listRegions(dataDir)
    const totals = address === null ? null : await allRegionBytes(address)
    const dtos = regions.map((region) => ({
      ...region,
      cachedBytes: totals?.[region.id] ?? (totals === null ? region.bytes : 0)
    }))
    res.status(200).json(dtos)
  })

  router.post('/api/regions', async (req, res) => {
    const { chartSourceById, estimateBytes } = await chartSources
    const b = (req.body ?? {}) as { bbox?: unknown, sourceIds?: unknown, minzoom?: unknown, maxzoom?: unknown, name?: unknown }
    const { bbox, sourceIds, minzoom, maxzoom, name } = b
    // Validate BEFORE touching the container so an invalid body is a 400 even with no address.
    if (!isValidBbox(bbox) ||
        !validSourceIds(sourceIds, false, chartSourceById) ||
        typeof minzoom !== 'number' || !Number.isInteger(minzoom) || minzoom < 0 || minzoom > MAX_WARM_ZOOM ||
        typeof maxzoom !== 'number' || !Number.isInteger(maxzoom) || maxzoom < 0 || maxzoom > MAX_WARM_ZOOM || minzoom > maxzoom ||
        typeof name !== 'string' || name.trim().length === 0 || name.trim().length > MAX_REGION_NAME_LENGTH) {
      res.status(400).json({ error: `bbox must be within world bounds; sourceIds must be non-empty and unique; zooms must be integers from 0 to ${MAX_WARM_ZOOM}; name must be 1 to ${MAX_REGION_NAME_LENGTH} characters` }); return
    }
    const address = withAddress(res); if (address === null) return
    // Re-validate the byte estimate authoritatively server-side, upfront, with the SHARED estimateBytes
    // (so the panel and the plugin agree), and refuse over-budget BEFORE persisting or starting the job.
    let stats: ContainerStats
    try {
      const statsResponse = await fetchImpl(`http://${address}${CONTAINER_STATS_PATH}`)
      if (!statsResponse.ok) {
        res.status(statsResponse.status).json({ error: 'tilecache statistics unavailable' }); return
      }
      const parsed = readContainerStats(await statsResponse.json())
      if (parsed === undefined) {
        res.status(502).json({ error: 'tilecache returned malformed statistics' }); return
      }
      stats = parsed
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' }); return
    }
    let estimate: number
    try {
      estimate = estimateBytes(sourceIds, bbox, [minzoom, maxzoom], stats.perSourceAvgBytes ?? {})
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        res.status(400).json({ error: 'invalid region estimate inputs' }); return
      }
      throw error
    }
    if (estimate > Math.max(0, stats.regionsFreeBytes ?? 0)) {
      res.status(400).json({ error: 'exceeds regions budget' }); return
    }
    const region: SavedRegion = {
      id: randomUUID(),
      name: name.trim(),
      bbox,
      sourceIds,
      minzoom,
      maxzoom,
      createdAt: nowUnixSecs(),
      lastDownloadedAt: null,
      bytes: 0,
      status: 'downloading'
    }
    addRegion(dataDir, region)
    try {
      const warmResp = await fetchImpl(`http://${address}${CONTAINER_WARM_PATH}`, warmInit({ sources: sourceIds, bbox, minzoom, maxzoom, regionId: region.id }))
      if (!warmResp.ok) {
        const body = await warmResp.json().catch(() => ({}))
        removeRegion(dataDir, region.id)
        res.status(warmResp.status).json(isRecord(body) ? body : { error: 'tilecache rejected warm start' })
        return
      }
      const warmBody = (await warmResp.json()) as { jobId?: unknown }
      if (typeof warmBody.jobId !== 'string' || warmBody.jobId.length === 0) {
        removeRegion(dataDir, region.id)
        res.status(502).json({ error: 'tilecache returned an invalid warm job' })
        return
      }
      const jobId = warmBody.jobId
      regionJobs.set(region.id, jobId)
      res.status(200).json({ region, jobId })
    } catch {
      // The warm start failed after the region was persisted: drop it so a failed start does not
      // linger as a downloading region with no job until the sweep.
      removeRegion(dataDir, region.id)
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  })

  router.delete('/api/regions/:id', async (req, res) => {
    const id = req.params.id
    if (!listRegions(dataDir).some((region) => region.id === id)) {
      res.status(404).json({ error: 'no such region' }); return
    }
    // Drop the container pins FIRST, then remove the region from the store only when that succeeds. The
    // container delete is idempotent, so a region that was never downloaded still succeeds. If the
    // container address is absent or the delete fails, return 503 and leave the region in the store so
    // the user can retry: removing it first would orphan its region_tiles pins and permanently shrink
    // regionsFreeBytes.
    const address = withAddress(res); if (address === null) return
    try {
      const r = await fetchImpl(`http://${address}${CONTAINER_REGION_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!r.ok) { res.status(r.status).end(); return }
    } catch {
      res.status(503).end(); return
    }
    removeRegion(dataDir, id)
    regionJobs.delete(id)
    res.status(204).end()
  })

  router.get('/api/regions/:id/status', async (req, res) => {
    const id = req.params.id
    const address = withAddress(res); if (address === null) return
    const jobId = regionJobs.get(id)
    if (jobId === undefined) {
      reconcileLostJob(id)
      res.status(404).json({ error: 'no job for region' }); return
    }
    try {
      const r = await fetchImpl(`http://${address}${CONTAINER_WARM_PATH}/${encodeURIComponent(jobId)}`)
      if (r.status === 404) {
        reconcileLostJob(id)
        res.status(404).json({ error: 'job gone' }); return
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        res.status(r.status).json(isRecord(body) ? body : { error: 'tilecache status unavailable' })
        return
      }
      const body = await r.json()
      if (!isWarmSnapshot(body)) {
        res.status(502).json({ error: 'tilecache returned a malformed warm status' }); return
      }
      const snapshot = body
      await reconcile(address, id, snapshot)
      res.status(r.status).json(snapshot)
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  })

  router.post('/api/regions/:id/redownload', async (req, res) => {
    const id = req.params.id
    const region = listRegions(dataDir).find((r) => r.id === id)
    if (!region) { res.status(404).json({ error: 'no such region' }); return }
    const address = withAddress(res); if (address === null) return
    // No upfront estimate gate here, unlike POST /api/regions. The container stages the replacement
    // under a temporary id, credits the target's current bytes during the download, and atomically
    // swaps the pins only when the final set fits the live budget.
    try {
      const warmResp = await fetchImpl(`http://${address}${CONTAINER_WARM_PATH}`, warmInit({
        sources: region.sourceIds, bbox: region.bbox, minzoom: region.minzoom, maxzoom: region.maxzoom, regionId: region.id
      }))
      if (!warmResp.ok) {
        const body = await warmResp.json().catch(() => ({}))
        res.status(warmResp.status).json(isRecord(body) ? body : { error: 'tilecache rejected re-download' })
        return
      }
      const body = (await warmResp.json()) as { jobId?: unknown }
      if (typeof body.jobId !== 'string' || body.jobId.length === 0) {
        res.status(502).json({ error: 'tilecache returned an invalid warm job' }); return
      }
      const { jobId } = body as { jobId: string }
      regionJobs.set(id, jobId)
      updateRegion(dataDir, id, { status: 'downloading' })
      res.status(200).json({ jobId })
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  })

  return true
}
