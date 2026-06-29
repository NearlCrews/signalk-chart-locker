/** The admin-gated tile, prewarm, region, and geocode routes. They persist the position-warm settings
 * and the saved regions through the regions store, and forward warm and cache operations to the tilecache
 * container. Mounted only when the admin gate holds, so an ungatable server leaves them unmounted (fail closed). */

import { randomUUID } from 'node:crypto'
import type { ServerAPI } from '@signalk/server-api'
import { estimateBytes } from 'signalk-binnacle-chart-sources'
import { ensureApiAdminGate } from '../shared/admin-gate.js'
import {
  loadPrewarmStore, savePrewarmStore, type PositionWarmSettings,
  addRegion, updateRegion, removeRegion, listRegions,
  type SavedRegion, type RegionStatus
} from '../runtime/prewarm-store.js'

export interface PrewarmRequest {
  params: Record<string, string>
  body: unknown
  query?: Record<string, string>
}

export interface PrewarmResponse {
  status (code: number): PrewarmResponse
  json (value: unknown): void
  end (): void
}

export interface PrewarmRouter {
  get (path: string, handler: (req: PrewarmRequest, res: PrewarmResponse) => void | Promise<void>): void
  post (path: string, handler: (req: PrewarmRequest, res: PrewarmResponse) => void | Promise<void>): void
  delete (path: string, handler: (req: PrewarmRequest, res: PrewarmResponse) => void | Promise<void>): void
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

type FetchImpl = (url: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<Response>

interface Deps {
  dataDir?: string
  fetchImpl?: FetchImpl
}

/** The floor for the position-warm interval, enforced server-side as well as in the panel. */
const MIN_WARM_INTERVAL_SECS = 60

/** A finite, correctly ordered lon/lat bbox: [minLng, minLat, maxLng, maxLat]. */
function isValidBbox (value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    value[0] < value[2] && value[1] < value[3]
}

/** Mount the prewarm routes behind the admin gate. Returns whether they were mounted. */
export function registerPrewarmRoutes (router: PrewarmRouter, app: ServerAPI, getAddress: () => string | null, deps: Deps = {}): boolean {
  if (!ensureApiAdminGate(app)) return false
  const dataDir = deps.dataDir ?? (app as unknown as { getDataDirPath(): string }).getDataDirPath()
  const fetchImpl: FetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))

  const withAddress = (res: PrewarmResponse): string | null => {
    const address = getAddress()
    if (address === null) {
      res.status(503).end()
      return null
    }
    return address
  }

  const relay = async (res: PrewarmResponse, upstream: Promise<Response>): Promise<void> => {
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
      const r = await fetchImpl(`http://${address}/cache/region/${encodeURIComponent(regionId)}`)
      if (!r.ok) return fallback
      const data = (await r.json()) as { bytes?: number }
      return typeof data.bytes === 'number' ? data.bytes : fallback
    } catch {
      return fallback
    }
  }

  const statusFromState = (state: WarmSnapshot['state']): RegionStatus => {
    if (state === 'done') return 'ready'
    if (state === 'capped') return 'capped'
    return 'error'
  }

  // Map a terminal warm snapshot to the persisted region status. A running snapshot leaves the region
  // untouched. A terminal snapshot writes status, lastDownloadedAt, and the container region_bytes.
  const reconcile = async (address: string, regionId: string, snapshot: WarmSnapshot): Promise<void> => {
    if (snapshot.state === 'running') return
    const bytes = await regionBytes(address, regionId, snapshot.bytes)
    updateRegion(dataDir, regionId, {
      status: statusFromState(snapshot.state),
      lastDownloadedAt: Math.floor(Date.now() / 1000),
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
  router.get('/api/prewarm/config', (_req, res) => {
    res.status(200).json(loadPrewarmStore(dataDir).positionWarm)
  })

  router.post('/api/prewarm/config', (req, res) => {
    const store = loadPrewarmStore(dataDir)
    const incoming = (req.body as { positionWarm?: Partial<PositionWarmSettings> } | undefined) ?? {}
    const positionWarm = { ...store.positionWarm, ...(incoming.positionWarm ?? {}) }
    // Floor the interval server-side (the panel enforces it too) so a direct POST cannot set a
    // sub-60-second loop that hammers the egress path.
    positionWarm.intervalSecs = Math.max(MIN_WARM_INTERVAL_SECS, positionWarm.intervalSecs)
    savePrewarmStore(dataDir, { ...store, positionWarm })
    res.status(204).end()
  })

  router.get('/api/cache/stats', async (_req, res) => {
    const address = withAddress(res); if (address === null) return
    return relay(res, fetchImpl(`http://${address}/cache/stats`))
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
    const dtos = await Promise.all(regions.map(async (region) => {
      // cachedBytes is cache-derived from the container; 0 when the container is unreachable.
      const cachedBytes = address === null ? 0 : await regionBytes(address, region.id, region.bytes)
      return { ...region, cachedBytes }
    }))
    res.status(200).json(dtos)
  })

  router.post('/api/regions', async (req, res) => {
    const b = (req.body ?? {}) as { bbox?: unknown, sourceIds?: unknown, minzoom?: unknown, maxzoom?: unknown, name?: unknown }
    const { bbox, sourceIds, minzoom, maxzoom, name } = b
    // Validate BEFORE touching the container so an invalid body is a 400 even with no address.
    if (!isValidBbox(bbox) ||
        !Array.isArray(sourceIds) || !sourceIds.every((s) => typeof s === 'string') ||
        typeof minzoom !== 'number' || !Number.isFinite(minzoom) ||
        typeof maxzoom !== 'number' || !Number.isFinite(maxzoom) || minzoom > maxzoom ||
        typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'a finite ordered bbox, a sourceIds array, minzoom <= maxzoom, and a non-empty name are required' }); return
    }
    const address = withAddress(res); if (address === null) return
    // Re-validate the byte estimate authoritatively server-side, upfront, with the SHARED estimateBytes
    // (so the panel and the plugin agree), and refuse over-budget BEFORE persisting or starting the job.
    let stats: ContainerStats
    try {
      stats = (await (await fetchImpl(`http://${address}/cache/stats`)).json()) as ContainerStats
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' }); return
    }
    const estimate = estimateBytes(sourceIds, bbox, [minzoom, maxzoom], stats.perSourceAvgBytes ?? {})
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
      createdAt: Math.floor(Date.now() / 1000),
      lastDownloadedAt: null,
      bytes: 0,
      status: 'downloading'
    }
    addRegion(dataDir, region)
    try {
      const warmResp = await fetchImpl(`http://${address}/warm`, warmInit({ sources: sourceIds, bbox, minzoom, maxzoom, regionId: region.id }))
      if (!warmResp.ok) throw new Error('warm start rejected')
      const { jobId } = (await warmResp.json()) as { jobId: string }
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
    // Drop the container pins FIRST, then remove the region from the store only when that succeeds. The
    // container delete is idempotent, so a region that was never downloaded still succeeds. If the
    // container address is absent or the delete fails, return 503 and leave the region in the store so
    // the user can retry: removing it first would orphan its region_tiles pins and permanently shrink
    // regionsFreeBytes.
    const address = withAddress(res); if (address === null) return
    let ok: boolean
    try {
      const r = await fetchImpl(`http://${address}/cache/region/${encodeURIComponent(id)}`, { method: 'DELETE' })
      ok = r.ok
    } catch {
      ok = false
    }
    if (!ok) { res.status(503).end(); return }
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
      const r = await fetchImpl(`http://${address}/warm/${encodeURIComponent(jobId)}`)
      if (r.status === 404) {
        reconcileLostJob(id)
        res.status(404).json({ error: 'job gone' }); return
      }
      const snapshot = (await r.json()) as WarmSnapshot
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
    try {
      // Same region.id: the container clears that region's prior pins at warm start, so the re-warm
      // replaces tiles and creates no duplicate region.
      const warmResp = await fetchImpl(`http://${address}/warm`, warmInit({
        sources: region.sourceIds, bbox: region.bbox, minzoom: region.minzoom, maxzoom: region.maxzoom, regionId: region.id
      }))
      const { jobId } = (await warmResp.json()) as { jobId: string }
      regionJobs.set(id, jobId)
      updateRegion(dataDir, id, { status: 'downloading' })
      res.status(200).json({ jobId })
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  })

  return true
}
