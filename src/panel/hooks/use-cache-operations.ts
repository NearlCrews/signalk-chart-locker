import { useCallback, useEffect, useRef, useState } from 'react'
import { PLUGIN_ID } from '../../shared/plugin-id.js'
import { isRecord } from '../../shared/record.js'
import { hasControlCharacter } from '../../shared/text.js'
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
  diskPressure: boolean | null
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

const MAX_SOURCE_ENTRIES = 256
const MAX_SOURCE_ID_LENGTH = 256

function nonnegativeNumber (value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`cache statistics ${field} must be a nonnegative finite number`)
  }
  return value
}

function nonnegativeInteger (value: unknown, field: string): number {
  const number = nonnegativeNumber(value, field)
  if (!Number.isSafeInteger(number)) {
    throw new TypeError(`cache statistics ${field} must be a nonnegative safe integer`)
  }
  return number
}

function sourceId (value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SOURCE_ID_LENGTH || hasControlCharacter(value)) {
    throw new TypeError(`cache statistics ${field} must be a bounded printable source identifier`)
  }
  return value
}

function parseBySource (value: unknown): CacheStats['bySource'] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_ENTRIES) {
    throw new TypeError('cache statistics bySource must be a bounded array')
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`cache statistics bySource[${index}] must be an object`)
    return {
      source: sourceId(entry.source, `bySource[${index}].source`),
      bytes: nonnegativeInteger(entry.bytes, `bySource[${index}].bytes`),
      rows: nonnegativeInteger(entry.rows, `bySource[${index}].rows`)
    }
  })
}

function parseUpstream (value: unknown): CacheStats['upstream'] {
  if (!isRecord(value)) throw new TypeError('cache statistics upstream must be an object')
  const entries = Object.entries(value)
  if (entries.length > MAX_SOURCE_ENTRIES) throw new TypeError('cache statistics upstream has too many entries')
  return Object.fromEntries(entries.map(([source, health]) => {
    sourceId(source, 'upstream source')
    if (!isRecord(health) || typeof health.slow !== 'boolean') {
      throw new TypeError(`cache statistics upstream.${source} must be a health object`)
    }
    return [source, {
      slow: health.slow,
      timeoutSecs: nonnegativeInteger(health.timeoutSecs, `upstream.${source}.timeoutSecs`),
      lastTimeoutAt: nonnegativeInteger(health.lastTimeoutAt, `upstream.${source}.lastTimeoutAt`)
    }]
  }))
}

export function parseCacheStats (raw: unknown): CacheStats {
  if (!isRecord(raw)) throw new TypeError('cache statistics must be an object')
  const body = raw
  if (!isRecord(body.diagnostics)) throw new TypeError('cache statistics diagnostics must be an object')
  const diagnostics = body.diagnostics
  const availableBytes = body.availableBytes === null
    ? null
    : nonnegativeInteger(body.availableBytes, 'availableBytes')
  const ttlDays = nonnegativeInteger(body.ttlDays, 'ttlDays')
  if (ttlDays > 365) throw new TypeError('cache statistics ttlDays must not exceed 365')
  if ((body.diskPressure !== null && typeof body.diskPressure !== 'boolean') || typeof body.configured !== 'boolean') {
    throw new TypeError('cache statistics state flags must be booleans, except diskPressure may be null')
  }

  return {
    rows: nonnegativeInteger(body.rows, 'rows'),
    bytes: nonnegativeInteger(body.bytes, 'bytes'),
    cap: nonnegativeInteger(body.cap, 'cap'),
    pinnedBytes: nonnegativeInteger(body.pinnedBytes, 'pinnedBytes'),
    scrollBytes: nonnegativeInteger(body.scrollBytes, 'scrollBytes'),
    regionsBudgetBytes: nonnegativeInteger(body.regionsBudgetBytes, 'regionsBudgetBytes'),
    regionsFreeBytes: nonnegativeInteger(body.regionsFreeBytes, 'regionsFreeBytes'),
    positionWarmBytes: nonnegativeInteger(body.positionWarmBytes, 'positionWarmBytes'),
    availableBytes,
    minimumHeadroomBytes: nonnegativeInteger(body.minimumHeadroomBytes, 'minimumHeadroomBytes'),
    diskPressure: body.diskPressure,
    configured: body.configured,
    ttlDays,
    bySource: parseBySource(body.bySource),
    upstream: parseUpstream(body.upstream),
    diagnostics: {
      diskPressureEvents: nonnegativeInteger(diagnostics.diskPressureEvents, 'diagnostics.diskPressureEvents'),
      warmRejections: nonnegativeInteger(diagnostics.warmRejections, 'diagnostics.warmRejections'),
      configPushes: nonnegativeInteger(diagnostics.configPushes, 'diagnostics.configPushes'),
      cacheOperationErrors: nonnegativeInteger(diagnostics.cacheOperationErrors, 'diagnostics.cacheOperationErrors')
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
  const refreshPromise = useRef<Promise<void> | null>(null)

  const refresh = useCallback((): Promise<void> => {
    if (refreshPromise.current !== null) return refreshPromise.current
    const request = (async () => {
      try {
        const next = parseCacheStats(await fetcher.fetchJson(`${API_BASE}/stats`))
        if (!fetcher.canceled()) {
          setStats(next)
          setError(null)
        }
      } catch (cause) {
        if (!fetcher.canceled()) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    refreshPromise.current = request
    request.then(
      () => {
        if (refreshPromise.current === request) refreshPromise.current = null
      },
      () => {
        if (refreshPromise.current === request) refreshPromise.current = null
      }
    )
    return request
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

  const refreshAfterActive = useCallback(async (): Promise<void> => {
    const active = refreshPromise.current
    if (active !== null) await active
    await refresh()
  }, [refresh])

  const mutate = useCallback(async (path: string, body?: unknown): Promise<void> => {
    setBusy(true)
    try {
      await fetcher.request(`${API_BASE}/${path}`, {
        method: 'POST',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      })
      // A poll that began before the mutation can only return the old state. Drain it, then require a
      // fresh read before the action finishes so the panel cannot report success with stale controls.
      await refreshAfterActive()
    } finally {
      if (!fetcher.canceled()) setBusy(false)
    }
  }, [fetcher, refreshAfterActive])

  return {
    stats,
    error,
    busy,
    refresh,
    setTtlDays: async (days) => mutate('config', { ttlDays: days }),
    clearScroll: async () => mutate('clear-scroll')
  }
}
