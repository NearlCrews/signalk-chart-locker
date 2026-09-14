import { useCallback, useEffect, useState } from 'react'
import { PLUGIN_ID } from '../../shared/plugin-id.js'
import { isRecord } from '../../shared/record.js'
import { hasControlCharacter } from '../../shared/text.js'
import { PANEL_MUTATION_TIMEOUT_MS } from '../request-timeout.js'
import { useAbortableFetch } from './use-abortable-fetch.js'

const URL = `/plugins/${PLUGIN_ID}/api/charts`

export interface ChartDiscoveryState {
  valid: number
  invalid: Array<{ fileName: string, error: string }>
  lastScanAt: number | null
}

const MAX_CHARTS = 4096
const MAX_DIAGNOSTIC_LENGTH = 4096

function diagnosticText (value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DIAGNOSTIC_LENGTH &&
    !hasControlCharacter(value)
    ? value
    : null
}

export function parseChartDiscovery (raw: unknown): ChartDiscoveryState {
  if (!isRecord(raw)) throw new TypeError('chart discovery response must be an object')
  if (!Array.isArray(raw.charts) || raw.charts.length > MAX_CHARTS) {
    throw new TypeError('chart discovery charts must be a bounded array')
  }
  if (!Array.isArray(raw.invalid) || raw.invalid.length > MAX_CHARTS) {
    throw new TypeError('chart discovery invalid list must be a bounded array')
  }
  if (!isRecord(raw.discovery)) throw new TypeError('chart discovery metadata must be an object')

  const invalid = raw.invalid.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`chart discovery invalid[${index}] must be an object`)
    const fileName = diagnosticText(item.fileName)
    const error = diagnosticText(item.error)
    if (fileName === null || error === null) {
      throw new TypeError(`chart discovery invalid[${index}] has malformed text`)
    }
    return { fileName, error }
  })
  const lastScanAt = raw.discovery.lastScanAt
  if (lastScanAt !== null && (typeof lastScanAt !== 'number' || !Number.isSafeInteger(lastScanAt) || lastScanAt < 0)) {
    throw new TypeError('chart discovery lastScanAt must be a nonnegative timestamp or null')
  }

  return {
    valid: raw.charts.length,
    invalid,
    lastScanAt
  }
}

export function useChartDiscovery (): {
  discovery: ChartDiscoveryState | null
  error: string | null
  rescan: () => Promise<ChartDiscoveryState | null>
} {
  const fetcher = useAbortableFetch()
  const [discovery, setDiscovery] = useState<ChartDiscoveryState | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Resolves with the state it committed, or null when the read failed or the panel unmounted, so
  // a caller can report the result without waiting for the state update to land.
  const load = useCallback(async (): Promise<ChartDiscoveryState | null> => {
    try {
      const next = parseChartDiscovery(await fetcher.fetchJson(URL))
      if (fetcher.canceled()) return null
      setDiscovery(next)
      setError(null)
      return next
    } catch (cause) {
      if (!fetcher.abandoned(cause)) setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [fetcher])

  useEffect(() => { load().catch(() => {}) }, [load])

  // No busy flag: the panel drives the rescan button's loading and disabled state from its own
  // pendingAction, so a second copy here would only re-render the panel twice per rescan.
  const rescan = useCallback(async (): Promise<ChartDiscoveryState | null> => {
    // A rescan reads and validates every PMTiles header in the charts directory, so it gets the
    // maintenance budget rather than the poller's.
    await fetcher.request(`${URL}/rescan`, { method: 'POST' }, PANEL_MUTATION_TIMEOUT_MS)
    return load()
  }, [fetcher, load])

  return { discovery, error, rescan }
}
