import { useCallback, useEffect, useState } from 'react'
import { PLUGIN_ID } from '../../shared/plugin-id.js'
import { isRecord } from '../../shared/record.js'
import { hasControlCharacter } from '../../shared/text.js'
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
  rescan: () => Promise<void>
} {
  const fetcher = useAbortableFetch()
  const [discovery, setDiscovery] = useState<ChartDiscoveryState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = parseChartDiscovery(await fetcher.fetchJson(URL))
      if (fetcher.canceled()) return
      setDiscovery(next)
      setError(null)
    } catch (cause) {
      if (!fetcher.abandoned(cause)) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [fetcher])

  useEffect(() => { load().catch(() => {}) }, [load])

  // No busy flag: the panel drives the rescan button's loading and disabled state from its own
  // pendingAction, so a second copy here would only re-render the panel twice per rescan.
  const rescan = useCallback(async (): Promise<void> => {
    await fetcher.request(`${URL}/rescan`, { method: 'POST' })
    await load()
  }, [fetcher, load])

  return { discovery, error, rescan }
}
