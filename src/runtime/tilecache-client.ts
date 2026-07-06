/** The shared warm client: POST a warm to the tilecache container and poll it to a terminal result. The
 * position-warm loop uses it so the warm POST and the status poll are spelled once, not re-rolled inline.
 * Returns the terminal { errors, total }, or null on any failure or a job the container no longer has. */

import type { Bbox } from 'signalk-chart-sources'
import { CONTAINER_FETCH_TIMEOUT_MS } from './container-fetch.js'

export interface WarmResult {
  errors: number
  total: number
}

const POLL_ATTEMPTS = 20
const POLL_INTERVAL_MS = 500
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

async function fetchWithRetry (url: string, options: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetchImpl(url, options)
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
  req: { bbox: Bbox, sources: string[], minzoom: number, maxzoom: number, regionId?: string },
  fetchImpl: typeof fetch = fetch
): Promise<WarmResult | null> {
  try {
    const start = await fetchWithRetry(`http://${address}/warm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)
    }, fetchImpl)
    if (!start.ok) return null
    const { jobId } = (await start.json()) as { jobId: string }
    // Poll briefly so the caller learns whether the warm was all-errors (offline) for its backoff decision.
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const status = await fetchImpl(`http://${address}/warm/${encodeURIComponent(jobId)}`, {
        signal: AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)
      })
      if (status.status === 404) return null
      const snap = (await status.json()) as { errors: number, total: number, state: string }
      if (snap.state !== 'running') return { errors: snap.errors, total: snap.total }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    return null
  } catch {
    return null
  }
}
