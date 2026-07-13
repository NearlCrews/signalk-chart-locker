/** The shared warm client: POST a warm to the tilecache container and poll it to a terminal result. The
 * position-warm loop uses it so the warm POST and the status poll are spelled once, not re-rolled inline.
 * Returns the terminal { errors, total }, or null on any failure or a job the container no longer has. */

import type { LngLatBbox } from 'signalk-chart-sources'
import { CONTAINER_FETCH_TIMEOUT_MS } from './container-fetch.js'

export interface WarmResult {
  errors: number
  total: number
}

/** Read all region byte totals in one request, or null when the container is unavailable or malformed. */
export async function getRegionByteTotals (address: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, number> | null> {
  try {
    const response = await fetchImpl(`http://${address}/cache/regions`, {
      signal: AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const body = (await response.json()) as { regions?: unknown }
    if (typeof body.regions !== 'object' || body.regions === null || Array.isArray(body.regions)) return null
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

const POLL_ATTEMPTS = 20
const POLL_INTERVAL_MS = 500
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000
const WARM_STATES = new Set(['running', 'done', 'cancelled', 'capped', 'error'])

// Each attempt gets its own timeout signal, so a slow attempt's timeout does not eat into the
// budget of the retries that follow it.
async function fetchWithRetry (url: string, options: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS) })
      if (res.status >= 500) {
        throw new Error(`Server error: ${res.status}`)
      }
      return res
    } catch (err) {
      lastError = err
      if (i < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (i + 1)))
      }
    }
  }
  throw lastError
}

export async function warmRegion (
  address: string,
  req: { bbox: LngLatBbox, sources: string[], minzoom: number, maxzoom: number, regionId?: string, additionalBbox?: LngLatBbox },
  fetchImpl: typeof fetch = fetch
): Promise<WarmResult | null> {
  try {
    // Starting a warm is not idempotent. Never retry this POST because a lost response can still mean
    // the container accepted the first job; retrying would create a second job for the same region.
    const start = await fetchImpl(`http://${address}/warm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)
    })
    if (!start.ok) return null
    const body = (await start.json()) as { jobId?: unknown }
    if (typeof body.jobId !== 'string' || body.jobId.length === 0) return null
    const jobId = body.jobId
    // Poll briefly so the caller learns whether the warm was all-errors (offline) for its backoff decision.
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const status = await fetchWithRetry(`http://${address}/warm/${encodeURIComponent(jobId)}`, {}, fetchImpl)
      if (status.status === 404) return null
      const snap = (await status.json()) as { errors?: unknown, total?: unknown, state?: unknown }
      if (typeof snap.state !== 'string' || !WARM_STATES.has(snap.state) || !isNonnegativeInteger(snap.errors) || !isNonnegativeInteger(snap.total)) return null
      if (snap.state !== 'running') return { errors: snap.errors, total: snap.total }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    return null
  } catch {
    return null
  }
}

function isNonnegativeInteger (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
