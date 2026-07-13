import { useCallback, useEffect, useRef, useState } from 'react'
import { PLUGIN_ID } from '../../shared/plugin-id.js'
import { useAbortableFetch } from './use-abortable-fetch.js'

const API_BASE = `/plugins/${PLUGIN_ID}/api/cache`
const POLL_MS = 10_000

export interface CacheStats {
  rows: number
  bytes: number
  cap: number
  pinnedBytes: number
  scrollBytes: number
  regionsBudgetBytes: number
  regionsFreeBytes: number
  positionWarmBytes: number
  availableBytes: number | null
  minimumHeadroomBytes: number
  diskPressure: boolean
  configured: boolean
  ttlDays: number
  bySource: Array<{ source: string, bytes: number, rows: number }>
  upstream: Record<string, { slow: boolean, timeoutSecs: number, lastTimeoutAt: number }>
  diagnostics: {
    diskPressureEvents: number
    warmRejections: number
    configPushes: number
    cacheOperationErrors: number
  }
}

function finite (value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseStats (raw: unknown): CacheStats {
  const body = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const diagnostics = typeof body.diagnostics === 'object' && body.diagnostics !== null
    ? body.diagnostics as Record<string, unknown>
    : {}
  return {
    rows: finite(body.rows),
    bytes: finite(body.bytes),
    cap: finite(body.cap),
    pinnedBytes: finite(body.pinnedBytes),
    scrollBytes: finite(body.scrollBytes),
    regionsBudgetBytes: finite(body.regionsBudgetBytes),
    regionsFreeBytes: finite(body.regionsFreeBytes),
    positionWarmBytes: finite(body.positionWarmBytes),
    availableBytes: typeof body.availableBytes === 'number' && Number.isFinite(body.availableBytes) ? body.availableBytes : null,
    minimumHeadroomBytes: finite(body.minimumHeadroomBytes),
    diskPressure: body.diskPressure === true,
    configured: body.configured === true,
    ttlDays: finite(body.ttlDays, 30),
    bySource: Array.isArray(body.bySource) ? body.bySource as CacheStats['bySource'] : [],
    upstream: typeof body.upstream === 'object' && body.upstream !== null ? body.upstream as CacheStats['upstream'] : {},
    diagnostics: {
      diskPressureEvents: finite(diagnostics.diskPressureEvents),
      warmRejections: finite(diagnostics.warmRejections),
      configPushes: finite(diagnostics.configPushes),
      cacheOperationErrors: finite(diagnostics.cacheOperationErrors)
    }
  }
}

export function useCacheOperations (): {
  stats: CacheStats | null
  error: string | null
  busy: boolean
  refresh: () => Promise<void>
  setTtlDays: (days: number) => Promise<void>
  clearScroll: () => Promise<void>
} {
  const fetcher = useAbortableFetch()
  const [stats, setStats] = useState<CacheStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const next = parseStats(await fetcher.fetchJson(`${API_BASE}/stats`))
      if (!fetcher.canceled()) {
        setStats(next)
        setError(null)
      }
    } catch (cause) {
      if (!fetcher.canceled()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlight.current = false
    }
  }, [fetcher])

  useEffect(() => {
    refresh().catch(() => {})
    const id = setInterval(() => { if (!document.hidden) refresh().catch(() => {}) }, POLL_MS)
    const visible = (): void => { if (!document.hidden) refresh().catch(() => {}) }
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])

  const mutate = useCallback(async (path: string, body?: unknown): Promise<void> => {
    setBusy(true)
    try {
      await fetcher.request(`${API_BASE}/${path}`, {
        method: 'POST',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      })
      await refresh()
    } finally {
      if (!fetcher.canceled()) setBusy(false)
    }
  }, [fetcher, refresh])

  return {
    stats,
    error,
    busy,
    refresh,
    setTtlDays: async (days) => mutate('config', { ttlDays: days }),
    clearScroll: async () => mutate('clear-scroll')
  }
}
