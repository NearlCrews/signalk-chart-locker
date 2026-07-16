/** The shared warm client: POST a warm to the tilecache container and poll it to a terminal result. The
 * position-warm loop uses it so the warm POST and the status poll are spelled once, not re-rolled inline.
 * Returns the terminal { errors, total }, or null on any failure or a job the container no longer has. */

import type { LngLatBbox } from 'signalk-chart-sources'
import { containerFetchSignal } from './container-fetch.js'
import { controlHeaders } from './control-token.js'
import { MAX_REGION_ID_LENGTH, MAX_REGION_TOTAL_ENTRIES } from './regions-store.js'
import { hasControlCharacter } from '../shared/text.js'
import { readBoundedResponseJson } from './bounded-response.js'
import { isWarmSnapshot, validWarmJobId, type WarmState } from './warm-contract.js'

export interface WarmResult {
  state: Exclude<WarmState, 'running'>
  errors: number
  total: number
}

/** Validate and bound the untrusted container region-total map. */
export function readRegionByteTotals (value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_REGION_TOTAL_ENTRIES) return null
  const totals = Object.create(null) as Record<string, number>
  for (const [id, bytes] of entries) {
    if (id.length === 0 || id.length > MAX_REGION_ID_LENGTH || hasControlCharacter(id) || !isNonnegativeInteger(bytes)) return null
    totals[id] = bytes
  }
  return totals
}

/** Read all region byte totals in one request, or null when the container is unavailable or malformed. */
export async function getRegionByteTotals (address: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Record<string, number> | null> {
  try {
    const response = await fetchImpl(`http://${address}/cache/regions`, {
      signal: containerFetchSignal(signal)
    })
    if (!response.ok) return null
    const body = (await readBoundedResponseJson(response)) as { regions?: unknown }
    return readRegionByteTotals(body.regions)
  } catch {
    return null
  }
}

const POLL_ATTEMPTS = 20
const POLL_INTERVAL_MS = 500
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

// Each attempt gets its own timeout signal, so a slow attempt's timeout does not eat into the
// budget of the retries that follow it.
function fetchSignal (signal?: AbortSignal): AbortSignal {
  return containerFetchSignal(signal)
}

function isAborted (signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

async function abortableDelay (delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(done, delayMs)
    const aborted = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    function done (): void {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted === true) aborted()
  })
}

async function fetchWithRetry (url: string, options: RequestInit, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (isAborted(signal)) throw new DOMException('Aborted', 'AbortError')
    try {
      const res = await fetchImpl(url, { ...options, signal: fetchSignal(signal) })
      if (res.status >= 500) {
        throw new Error(`Server error: ${res.status}`)
      }
      return res
    } catch (err) {
      lastError = err
      if (isAborted(signal)) throw err
      if (i < MAX_RETRIES - 1) {
        await abortableDelay(RETRY_DELAY_MS * (i + 1), signal)
      }
    }
  }
  throw lastError
}

export async function warmRegion (
  address: string,
  req: { bbox: LngLatBbox, sources: string[], minzoom: number, maxzoom: number, regionId?: string, additionalBbox?: LngLatBbox },
  fetchImpl: typeof fetch = fetch,
  controlToken?: string,
  signal?: AbortSignal
): Promise<WarmResult | null> {
  try {
    // Starting a warm is not idempotent. Never retry this POST because a lost response can still mean
    // the container accepted the first job; retrying would create a second job for the same region.
    const start = await fetchImpl(`http://${address}/warm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(controlToken === undefined ? {} : controlHeaders(controlToken)) },
      body: JSON.stringify(req),
      signal: fetchSignal(signal)
    })
    if (!start.ok) return null
    const body = (await readBoundedResponseJson(start)) as { jobId?: unknown }
    if (!validWarmJobId(body.jobId)) return null
    const jobId = body.jobId
    // Poll briefly so the caller learns whether the warm was all-errors (offline) for its backoff decision.
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const status = await fetchWithRetry(`http://${address}/warm/${encodeURIComponent(jobId)}`, {}, fetchImpl, signal)
      if (status.status === 404) return null
      const snap = await readBoundedResponseJson(status)
      if (!isWarmSnapshot(snap)) return null
      if (snap.state !== 'running') return { state: snap.state, errors: snap.errors, total: snap.total }
      await abortableDelay(POLL_INTERVAL_MS, signal)
    }
    return null
  } catch {
    return null
  }
}

function isNonnegativeInteger (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
