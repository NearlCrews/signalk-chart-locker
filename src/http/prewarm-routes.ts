/** The admin-gated prewarm and config routes: the single write surface for the prewarm box. They persist
 * the box and the settings (the source of truth) and forward warm operations to the tilecache container.
 * Mounted only when the admin gate holds, so an ungatable server leaves them unmounted (fail closed). */

import type { ServerAPI } from '@signalk/server-api'
import { ensureApiAdminGate } from '../shared/admin-gate.js'
import { loadPrewarmConfig, savePrewarmConfig, type PrewarmConfig } from '../runtime/prewarm-store.js'

export interface PrewarmRequest {
  params: Record<string, string>
  body: unknown
}

export interface PrewarmResponse {
  status (code: number): PrewarmResponse
  json (value: unknown): void
  end (): void
}

export interface PrewarmRouter {
  get (path: string, handler: (req: PrewarmRequest, res: PrewarmResponse) => void | Promise<void>): void
  post (path: string, handler: (req: PrewarmRequest, res: PrewarmResponse) => void | Promise<void>): void
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

  // Relay a no-content upstream (the 204 cancel) without reading a JSON body: a 204 carries none, so
  // r.json() would throw and mask the real status.
  const relayNoContent = async (res: PrewarmResponse, upstream: Promise<Response>): Promise<void> => {
    try {
      const r = await upstream
      res.status(r.status).end()
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  }

  router.post('/api/prewarm', async (req, res) => {
    const address = withAddress(res); if (address === null) return
    const b = (req.body ?? {}) as Partial<PrewarmConfig>
    const current = loadPrewarmConfig(dataDir)
    const minzoom = b.minzoom ?? current.minzoom
    const maxzoom = b.maxzoom ?? current.maxzoom
    // Validate BEFORE persisting: a non-finite or inverted bbox stored as the source of truth would be
    // compared against NaN in the position-warm insideBox check (always false) and warm continuously.
    if (!isValidBbox(b.bbox) || !Array.isArray(b.sources) || minzoom > maxzoom) {
      res.status(400).json({ error: 'a finite, ordered bbox, a sources array, and minzoom <= maxzoom are required' }); return
    }
    savePrewarmConfig(dataDir, { ...current, bbox: b.bbox, sources: b.sources, minzoom, maxzoom })
    return relay(res, fetchImpl(`http://${address}/warm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: b.sources, bbox: b.bbox, minzoom, maxzoom })
    }))
  })

  router.get('/api/prewarm/status/:jobId', async (req, res) => {
    const address = withAddress(res); if (address === null) return
    return relay(res, fetchImpl(`http://${address}/warm/${encodeURIComponent(req.params.jobId)}`))
  })

  router.post('/api/prewarm/cancel/:jobId', async (req, res) => {
    const address = withAddress(res); if (address === null) return
    return relayNoContent(res, fetchImpl(`http://${address}/warm/${encodeURIComponent(req.params.jobId)}/cancel`, { method: 'POST' }))
  })

  router.get('/api/prewarm/config', (_req, res) => {
    res.status(200).json(loadPrewarmConfig(dataDir))
  })

  router.post('/api/prewarm/config', (req, res) => {
    const current = loadPrewarmConfig(dataDir)
    const incoming = (req.body as Partial<PrewarmConfig> | undefined) ?? {}
    const positionWarm = { ...current.positionWarm, ...(incoming.positionWarm ?? {}) }
    // Floor the interval server-side (the panel enforces it too) so a direct POST cannot set a
    // sub-60-second loop that hammers the egress path.
    positionWarm.intervalSecs = Math.max(MIN_WARM_INTERVAL_SECS, positionWarm.intervalSecs)
    savePrewarmConfig(dataDir, { ...current, ...incoming, positionWarm })
    res.status(204).end()
  })

  router.get('/api/cache/stats', async (_req, res) => {
    const address = withAddress(res); if (address === null) return
    return relay(res, fetchImpl(`http://${address}/cache/stats`))
  })

  return true
}
