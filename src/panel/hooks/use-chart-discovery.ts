import { useCallback, useEffect, useState } from 'react'
import { PLUGIN_ID } from '../../shared/plugin-id.js'
import { useAbortableFetch } from './use-abortable-fetch.js'

const URL = `/plugins/${PLUGIN_ID}/api/charts`

export interface ChartDiscoveryState {
  valid: number
  invalid: Array<{ fileName: string, error: string }>
  lastScanAt: number | null
}

export function useChartDiscovery (): {
  discovery: ChartDiscoveryState | null
  error: string | null
  busy: boolean
  rescan: () => Promise<void>
} {
  const fetcher = useAbortableFetch()
  const [discovery, setDiscovery] = useState<ChartDiscoveryState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const body = await fetcher.fetchJson(URL) as {
        charts?: unknown[]
        invalid?: Array<{ fileName?: unknown, error?: unknown }>
        discovery?: { lastScanAt?: unknown }
      }
      if (fetcher.canceled()) return
      setDiscovery({
        valid: Array.isArray(body.charts) ? body.charts.length : 0,
        invalid: Array.isArray(body.invalid)
          ? body.invalid.filter((item): item is { fileName: string, error: string } => typeof item.fileName === 'string' && typeof item.error === 'string')
          : [],
        lastScanAt: typeof body.discovery?.lastScanAt === 'number' ? body.discovery.lastScanAt : null
      })
      setError(null)
    } catch (cause) {
      if (!fetcher.canceled()) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [fetcher])

  useEffect(() => { load().catch(() => {}) }, [load])

  const rescan = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await fetcher.request(`${URL}/rescan`, { method: 'POST' })
      await load()
    } finally {
      if (!fetcher.canceled()) setBusy(false)
    }
  }, [fetcher, load])

  return { discovery, error, busy, rescan }
}
