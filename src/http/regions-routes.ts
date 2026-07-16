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
  reconcilePositionWarmSources, MAX_SAVED_REGIONS, MAX_WARM_ZOOM, type SavedRegion, type RegionStatus
} from '../runtime/regions-store.js'
import { nowUnixSecs } from '../shared/time.js'
import { controlHeaders } from '../runtime/control-token.js'
import { readRegionByteTotals } from '../runtime/tilecache-client.js'
import { normalizePrintableText } from '../shared/text.js'
import {
  isWarmJobSnapshot,
  isWarmSnapshot,
  validWarmJobId,
  type WarmJobSnapshot,
  type WarmSnapshot
} from '../runtime/warm-contract.js'
import { readBoundedResponseJson } from '../runtime/bounded-response.js'

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

/** Stats the budget re-validation reads from the container. */
interface ContainerStats {
  regionsFreeBytes?: number
  perSourceAvgBytes?: Record<string, number>
}

type FetchImpl = (url: string, init?: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }) => Promise<Response>

interface Deps {
  dataDir?: string
  fetchImpl?: FetchImpl
  getControlToken?: () => string | null
  isGeocodingEnabled?: () => boolean
  pollIntervalMs?: number
  reconciliationRequestSpacingMs?: number
}

export interface RegionsRoutesHandle {
  start: () => void
  stop: () => Promise<void>
}

/** The floor for the position-warm interval, enforced server-side as well as in the panel. */
const MIN_WARM_INTERVAL_SECS = 60
const MAX_WARM_INTERVAL_SECS = 86_400
const MAX_WARM_DISTANCE_METERS = 100_000
const MAX_SOURCE_IDS = 64
const MAX_SOURCE_ID_LENGTH = 256
const MAX_REGION_NAME_LENGTH = 120

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
  const averages = Object.create(null) as Record<string, number>
  if (value.perSourceAvgBytes !== undefined) {
    if (!isRecord(value.perSourceAvgBytes)) return undefined
    for (const [source, bytes] of Object.entries(value.perSourceAvgBytes)) {
      if (!isNonnegativeInteger(bytes) || bytes === 0) return undefined
      averages[source] = bytes
    }
  }
  return { regionsFreeBytes: value.regionsFreeBytes, perSourceAvgBytes: averages }
}

function storageStatus (error: unknown): number {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return code === 'ENOSPC' || code === 'EDQUOT' ? 507 : 500
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
export function registerRegionsRoutes (router: RegionsRouter, app: ServerAPI, getAddress: () => string | null, deps: Deps = {}): false | RegionsRoutesHandle {
  if (!ensureApiAdminGate(app)) return false
  const dataDir = deps.dataDir ?? app.getDataDirPath()
  const rawFetch: FetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  // Wrap every container fetch with a bounded timeout, so a hung container endpoint (for example a
  // deadlocked /cache/stats) surfaces as a caught failure and a 502 or 503, never an open request that
  // hangs the panel. A caller that supplies its own signal keeps it.
  let active = false
  let lifecycleController = new AbortController()
  const fetchImpl: FetchImpl = (url, init) => {
    const signals = [AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS), lifecycleController.signal]
    if (init?.signal !== undefined) signals.push(init.signal)
    return rawFetch(url, { ...init, signal: AbortSignal.any(signals) })
  }

  const storageFailure = (res: RegionsResponse, error: unknown): void => {
    app.debug('Plugin state persistence failed:', error)
    res.status(storageStatus(error)).json({ error: 'unable to persist plugin state' })
  }

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
    let response: Response
    try {
      response = await upstream
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
      return
    }
    try {
      res.status(response.status).json(await readBoundedResponseJson(response))
    } catch {
      res.status(502).json({ error: 'tilecache returned a malformed response' })
    }
  }

  // The latest warm job per region. The container lookup by region recovers this map after a lost POST
  // response or plugin restart, while background tasks own reconciliation independently of client polling.
  const regionJobs = new Map<string, string>()
  const trackedRegions = new Set<string>()
  let reconciliationLoop: Promise<void> | null = null
  const pollIntervalMs = deps.pollIntervalMs ?? 1000
  const requestSpacingMs = deps.reconciliationRequestSpacingMs ?? 50

  const mutationHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
    const token = deps.getControlToken?.()
    return { ...extra, ...(token === undefined || token === null ? {} : controlHeaders(token)) }
  }

  const warmInit = (body: unknown): { method: string, headers: Record<string, string>, body: string } => ({
    method: 'POST',
    headers: mutationHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  })

  const waitFor = async (delayMs: number): Promise<void> => {
    const signal = lifecycleController.signal
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
        resolve()
      }
      const aborted = (): void => { done() }
      const timer = setTimeout(done, delayMs)
      timer.unref()
      signal.addEventListener('abort', aborted, { once: true })
      // Close the race where abort fires after the first check but before listener registration.
      if (signal.aborted) done()
    })
  }

  // Best-effort container region_bytes. The authoritative flag keeps terminal jobs tracked until a
  // later sweep can replace the durable pre-job total with the container's final total.
  const regionBytes = async (address: string, regionId: string, fallback: number): Promise<{ bytes: number, authoritative: boolean }> => {
    try {
      const r = await fetchImpl(`http://${address}${CONTAINER_REGION_PATH}/${encodeURIComponent(regionId)}`)
      if (!r.ok) return { bytes: fallback, authoritative: false }
      const data = (await readBoundedResponseJson(r)) as { bytes?: number }
      return isNonnegativeInteger(data.bytes)
        ? { bytes: data.bytes, authoritative: true }
        : { bytes: fallback, authoritative: false }
    } catch {
      return { bytes: fallback, authoritative: false }
    }
  }

  const allRegionBytes = async (address: string): Promise<Record<string, number> | null> => {
    try {
      const response = await fetchImpl(`http://${address}${CONTAINER_REGIONS_PATH}`)
      if (!response.ok) return null
      const body = (await readBoundedResponseJson(response)) as { regions?: unknown }
      return readRegionByteTotals(body.regions)
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
  const reconcile = async (address: string, regionId: string, snapshot: WarmSnapshot): Promise<boolean> => {
    if (snapshot.state === 'running') return true
    const region = listRegions(dataDir).find((candidate) => candidate.id === regionId)
    if (region === undefined) return true
    const result = await regionBytes(address, regionId, region.bytes)
    const status = statusFromSnapshot(snapshot)
    const patch: Partial<SavedRegion> = {}
    if (region.status !== status || region.lastDownloadedAt === null) {
      patch.status = status
      patch.lastDownloadedAt = nowUnixSecs()
    }
    if (result.authoritative && region.bytes !== result.bytes) patch.bytes = result.bytes
    if (Object.keys(patch).length > 0) updateRegion(dataDir, regionId, patch)
    return result.authoritative
  }

  // A region whose job is gone must not stay downloading.
  const reconcileLostJob = (regionId: string): void => {
    const region = listRegions(dataDir).find((r) => r.id === regionId)
    if (region && region.status === 'downloading') {
      updateRegion(dataDir, regionId, { status: 'error' })
    }
  }

  type JobLookup = WarmJobSnapshot | 'gone' | 'unreachable'

  const lookupJobByRegion = async (address: string, regionId: string): Promise<JobLookup> => {
    try {
      const response = await fetchImpl(`http://${address}${CONTAINER_WARM_PATH}/region/${encodeURIComponent(regionId)}`)
      if (response.status === 404) return 'gone'
      if (!response.ok) return 'unreachable'
      const body = await readBoundedResponseJson(response)
      return isWarmJobSnapshot(body) ? body : 'unreachable'
    } catch {
      return 'unreachable'
    }
  }

  const getJobSnapshot = async (address: string, jobId: string): Promise<WarmSnapshot | 'gone' | 'unreachable'> => {
    try {
      const response = await fetchImpl(`http://${address}${CONTAINER_WARM_PATH}/${encodeURIComponent(jobId)}`)
      if (response.status === 404) return 'gone'
      if (!response.ok) return 'unreachable'
      const body = await readBoundedResponseJson(response)
      return isWarmSnapshot(body) ? body : 'unreachable'
    } catch {
      return 'unreachable'
    }
  }

  const reconcileOne = async (regionId: string): Promise<void> => {
    const address = getAddress()
    if (address === null) return
    let jobId = regionJobs.get(regionId)
    if (jobId === undefined) {
      const lookup = await lookupJobByRegion(address, regionId)
      if (lookup === 'unreachable') return
      if (lookup === 'gone') {
        try {
          reconcileLostJob(regionId)
          trackedRegions.delete(regionId)
        } catch (error) {
          app.debug('Lost region-job reconciliation persistence failed:', error)
        }
        return
      }
      jobId = lookup.jobId
      regionJobs.set(regionId, jobId)
      if (lookup.state !== 'running') {
        try {
          const authoritative = await reconcile(address, regionId, lookup)
          if (authoritative) {
            trackedRegions.delete(regionId)
            regionJobs.delete(regionId)
          }
        } catch (error) {
          app.debug('Region reconciliation persistence failed:', error)
        }
        return
      }
    }

    const snapshot = await getJobSnapshot(address, jobId)
    if (snapshot === 'unreachable') return
    if (snapshot === 'gone') {
      // Resolve by region on the next sweep in case a newer retained job superseded this exact id.
      regionJobs.delete(regionId)
      return
    }
    if (snapshot.state === 'running') return
    try {
      const authoritative = await reconcile(address, regionId, snapshot)
      if (authoritative) {
        trackedRegions.delete(regionId)
        regionJobs.delete(regionId)
      }
    } catch (error) {
      app.debug('Region reconciliation persistence failed:', error)
    }
  }

  const ensureReconciliationLoop = (): void => {
    if (!active || reconciliationLoop !== null || trackedRegions.size === 0) return
    reconciliationLoop = (async () => {
      for (;;) {
        if (!active || lifecycleController.signal.aborted || trackedRegions.size === 0) break
        await waitFor(pollIntervalMs)
        for (const regionId of [...trackedRegions].slice(0, MAX_SAVED_REGIONS)) {
          if (!active || lifecycleController.signal.aborted) break
          await reconcileOne(regionId)
          if (requestSpacingMs > 0) await waitFor(requestSpacingMs)
        }
      }
    })().catch((error: unknown) => {
      app.debug('Region reconciliation loop failed:', error)
    }).finally(() => {
      reconciliationLoop = null
      if (active && trackedRegions.size > 0) ensureReconciliationLoop()
    })
  }

  const trackRegionJob = (regionId: string, jobId?: string): void => {
    if (jobId !== undefined && validWarmJobId(jobId)) regionJobs.set(regionId, jobId)
    trackedRegions.add(regionId)
    ensureReconciliationLoop()
  }

  // The position-warm settings live in the regions store. GET returns just the positionWarm block and
  // POST merges ONLY the incoming positionWarm, preserving the saved regions, so saving settings never
  // drops a region.
  router.get('/api/position-warm/config', (_req, res) => {
    try {
      res.status(200).json(loadRegionsStore(dataDir).positionWarm)
    } catch (error) {
      storageFailure(res, error)
    }
  })

  router.post('/api/position-warm/config', async (req, res) => {
    if (!isRecord(req.body) || !('positionWarm' in req.body)) {
      res.status(400).json({ error: 'positionWarm is required' }); return
    }
    const { chartSourceById } = await chartSources
    const patch = readPositionWarmPatch(req.body.positionWarm, chartSourceById)
    if (typeof patch === 'string') { res.status(400).json({ error: patch }); return }
    try {
      mutateRegionsStore(dataDir, (store) => {
        store.positionWarm = { ...store.positionWarm, ...patch }
      })
    } catch (error) {
      storageFailure(res, error); return
    }
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
    try {
      mutateRegionsStore(dataDir, (store) => { store.cacheScrollTtlDays = ttlDays })
    } catch (error) {
      storageFailure(res, error); return
    }
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
    return relay(res, fetchImpl(`http://${address}/cache/clear-scroll`, { method: 'POST', headers: mutationHeaders() }))
  })

  router.get('/api/cache/stats', async (_req, res) => {
    const address = withAddress(res); if (address === null) return
    // Not a pure relay: the container stats are merged with ttlDays from the store (the plugin owns the
    // TTL persistence), so the panel reads the TTL and the cache breakdown in one round-trip.
    let response: Response
    try {
      response = await fetchImpl(`http://${address}${CONTAINER_STATS_PATH}`)
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
      return
    }
    let body: Record<string, unknown>
    try {
      const parsed = await readBoundedResponseJson(response)
      if (!isRecord(parsed)) throw new TypeError('tilecache statistics must be an object')
      body = parsed
    } catch {
      res.status(502).json({ error: 'tilecache returned malformed statistics' })
      return
    }
    try {
      const ttlDays = loadRegionsStore(dataDir).cacheScrollTtlDays
      res.status(response.status).json({ ...body, ttlDays })
    } catch (error) {
      storageFailure(res, error)
    }
  })

  router.get('/api/geocode', async (req, res) => {
    if (deps.isGeocodingEnabled?.() === false) {
      res.status(404).json({ error: 'reverse geocoding is disabled' }); return
    }
    const address = withAddress(res); if (address === null) return
    const query = (req.query ?? {})
    const { lat, lon } = query
    if (!lat || !lon) { res.status(400).json({ error: 'lat and lon are required' }); return }
    return relay(res, fetchImpl(`http://${address}/geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`))
  })

  router.get('/api/regions', async (_req, res) => {
    const address = getAddress()
    let regions: SavedRegion[]
    try {
      const { chartSourceById } = await chartSources
      reconcilePositionWarmSources(dataDir, (id) => chartSourceById(id) !== undefined)
      regions = listRegions(dataDir)
      const totals = address === null ? null : await allRegionBytes(address)
      const dtos = regions.map((region) => ({
        ...region,
        unavailableSourceIds: region.sourceIds.filter((id) => chartSourceById(id) === undefined),
        cachedBytes: totals?.[region.id] ?? (totals === null ? region.bytes : 0)
      }))
      res.status(200).json(dtos)
    } catch (error) {
      storageFailure(res, error)
    }
  })

  router.post('/api/regions', async (req, res) => {
    const { chartSourceById, estimateBytes } = await chartSources
    const b = (req.body ?? {}) as { bbox?: unknown, sourceIds?: unknown, minzoom?: unknown, maxzoom?: unknown, name?: unknown }
    const { bbox, sourceIds, minzoom, maxzoom, name } = b
    const normalizedName = normalizePrintableText(name, MAX_REGION_NAME_LENGTH)
    // Validate BEFORE touching the container so an invalid body is a 400 even with no address.
    if (!isValidBbox(bbox) ||
        !validSourceIds(sourceIds, false, chartSourceById) ||
        typeof minzoom !== 'number' || !Number.isInteger(minzoom) || minzoom < 0 || minzoom > MAX_WARM_ZOOM ||
        typeof maxzoom !== 'number' || !Number.isInteger(maxzoom) || maxzoom < 0 || maxzoom > MAX_WARM_ZOOM || minzoom > maxzoom ||
        normalizedName === undefined) {
      res.status(400).json({ error: `bbox must be within world bounds; sourceIds must be non-empty and unique; zooms must be integers from 0 to ${MAX_WARM_ZOOM}; name must be 1 to ${MAX_REGION_NAME_LENGTH} printable characters` }); return
    }
    const address = withAddress(res); if (address === null) return
    // Re-validate the byte estimate authoritatively server-side, upfront, with the SHARED estimateBytes
    // (so the panel and the plugin agree), and refuse over-budget BEFORE persisting or starting the job.
    let statsResponse: Response
    try {
      statsResponse = await fetchImpl(`http://${address}${CONTAINER_STATS_PATH}`)
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' }); return
    }
    if (!statsResponse.ok) {
      res.status(statsResponse.status).json({ error: 'tilecache statistics unavailable' }); return
    }
    let stats: ContainerStats | undefined
    try {
      stats = readContainerStats(await readBoundedResponseJson(statsResponse))
    } catch {
      stats = undefined
    }
    if (stats === undefined) {
      res.status(502).json({ error: 'tilecache returned malformed statistics' }); return
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
    try {
      if (listRegions(dataDir).length >= MAX_SAVED_REGIONS) {
        res.status(409).json({ error: `saved region limit is ${MAX_SAVED_REGIONS}` }); return
      }
    } catch (error) {
      storageFailure(res, error); return
    }
    const region: SavedRegion = {
      id: randomUUID(),
      name: normalizedName,
      bbox,
      sourceIds,
      minzoom,
      maxzoom,
      createdAt: nowUnixSecs(),
      lastDownloadedAt: null,
      bytes: 0,
      status: 'downloading'
    }
    try {
      addRegion(dataDir, region)
    } catch (error) {
      storageFailure(res, error); return
    }
    const responseRegion = { ...region, cachedBytes: 0 }
    try {
      const warmResp = await fetchImpl(`http://${address}${CONTAINER_WARM_PATH}`, warmInit({ sources: sourceIds, bbox, minzoom, maxzoom, regionId: region.id }))
      if (!warmResp.ok) {
        const body = await readBoundedResponseJson(warmResp).catch(() => null)
        try {
          removeRegion(dataDir, region.id)
        } catch (error) {
          storageFailure(res, error); return
        }
        res.status(warmResp.status).json(isRecord(body) ? body : { error: 'tilecache rejected warm start' })
        return
      }
      const warmBody = (await readBoundedResponseJson(warmResp)) as { jobId?: unknown }
      if (!validWarmJobId(warmBody.jobId)) {
        trackRegionJob(region.id)
        res.status(202).json({ region: responseRegion, recovery: 'pending' })
        return
      }
      const jobId = warmBody.jobId
      trackRegionJob(region.id, jobId)
      res.status(200).json({ region: responseRegion, jobId })
    } catch {
      // The non-idempotent POST may have been accepted before its response was lost. Preserve the
      // durable region and recover the newest job through the region lookup contract.
      trackRegionJob(region.id)
      res.status(202).json({ region: responseRegion, recovery: 'pending' })
    }
  })

  router.delete('/api/regions/:id', async (req, res) => {
    const id = req.params.id
    let exists: boolean
    try {
      exists = listRegions(dataDir).some((region) => region.id === id)
    } catch (error) {
      storageFailure(res, error); return
    }
    if (!exists) {
      res.status(404).json({ error: 'no such region' }); return
    }
    // Drop the container pins FIRST, then remove the region from the store only when that succeeds. The
    // container delete is idempotent, so a region that was never downloaded still succeeds. If the
    // container address is absent or the delete fails, return 503 and leave the region in the store so
    // the user can retry: removing it first would orphan its region_tiles pins and permanently shrink
    // regionsFreeBytes.
    const address = withAddress(res); if (address === null) return
    try {
      const r = await fetchImpl(`http://${address}${CONTAINER_REGION_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: mutationHeaders() })
      if (!r.ok) { res.status(r.status).end(); return }
    } catch {
      res.status(503).end(); return
    }
    try {
      removeRegion(dataDir, id)
    } catch (error) {
      storageFailure(res, error); return
    }
    trackedRegions.delete(id)
    regionJobs.delete(id)
    res.status(204).end()
  })

  router.get('/api/regions/:id/status', async (req, res) => {
    const id = req.params.id
    try {
      if (!listRegions(dataDir).some((region) => region.id === id)) {
        res.status(404).json({ error: 'no such region' }); return
      }
    } catch (error) {
      storageFailure(res, error); return
    }
    const address = withAddress(res); if (address === null) return
    let snapshot: WarmSnapshot | WarmJobSnapshot | 'gone' | 'unreachable'
    const knownJobId = regionJobs.get(id)
    snapshot = knownJobId === undefined
      ? await lookupJobByRegion(address, id)
      : await getJobSnapshot(address, knownJobId)
    if (snapshot === 'gone' && knownJobId !== undefined) {
      // The exact job can expire while a newer job for the same region remains retained.
      snapshot = await lookupJobByRegion(address, id)
    }
    if (snapshot === 'unreachable') {
      res.status(502).json({ error: 'tilecache status unavailable' }); return
    }
    if (snapshot === 'gone') {
      try {
        reconcileLostJob(id)
      } catch (error) {
        storageFailure(res, error); return
      }
      res.status(404).json({ error: 'no job for region' }); return
    }
    if ('jobId' in snapshot) regionJobs.set(id, snapshot.jobId)
    try {
      const authoritative = await reconcile(address, id, snapshot)
      if (!authoritative && snapshot.state !== 'running') {
        const jobId = 'jobId' in snapshot ? snapshot.jobId : knownJobId
        trackRegionJob(id, jobId)
      }
    } catch (error) {
      storageFailure(res, error); return
    }
    res.status(200).json(snapshot)
  })

  router.post('/api/regions/:id/redownload', async (req, res) => {
    const id = req.params.id
    let region: SavedRegion | undefined
    try {
      region = listRegions(dataDir).find((r) => r.id === id)
    } catch (error) {
      storageFailure(res, error); return
    }
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
        const body = await readBoundedResponseJson(warmResp).catch(() => null)
        res.status(warmResp.status).json(isRecord(body) ? body : { error: 'tilecache rejected re-download' })
        return
      }
      const body = (await readBoundedResponseJson(warmResp)) as { jobId?: unknown }
      if (!validWarmJobId(body.jobId)) {
        trackRegionJob(id)
        try {
          updateRegion(dataDir, id, { status: 'downloading' })
        } catch (error) {
          storageFailure(res, error); return
        }
        res.status(202).json({ recovery: 'pending' }); return
      }
      const { jobId } = body as { jobId: string }
      regionJobs.set(id, jobId)
      trackedRegions.add(id)
      try {
        updateRegion(dataDir, id, { status: 'downloading' })
      } catch (error) {
        ensureReconciliationLoop()
        storageFailure(res, error); return
      }
      ensureReconciliationLoop()
      res.status(200).json({ jobId })
    } catch {
      trackRegionJob(id)
      try {
        updateRegion(dataDir, id, { status: 'downloading' })
      } catch (error) {
        storageFailure(res, error); return
      }
      res.status(202).json({ recovery: 'pending' })
    }
  })

  const handle: RegionsRoutesHandle = {
    start () {
      if (active) return
      active = true
      lifecycleController = new AbortController()
      try {
        for (const region of listRegions(dataDir)) {
          if (region.status === 'downloading') trackRegionJob(region.id)
        }
      } catch (error) {
        app.debug('Cannot resume saved-region reconciliation:', error)
      }
      ensureReconciliationLoop()
    },
    async stop () {
      if (!active) return
      active = false
      lifecycleController.abort()
      if (reconciliationLoop !== null) await reconciliationLoop
      trackedRegions.clear()
      regionJobs.clear()
    }
  }
  return handle
}
