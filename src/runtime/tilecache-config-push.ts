/** Builds the tilecache POST /config payload from the shared source registry and pushes it to the container. */

import type { ChartSource } from 'signalk-chart-sources'
import { containerFetchSignal } from './container-fetch.js'
import { PLUGIN_MOUNT_PATH } from '../shared/plugin-id.js'
import { controlHeaders } from './control-token.js'
import { MAX_MANAGED_CONTAINER_ERROR_BYTES, readBoundedResponseText } from './bounded-response.js'

/** The Signal K server route base the browser reaches the proxy through (for the container style rewrite). */
export const PLUGIN_PUBLIC_BASE = PLUGIN_MOUNT_PATH

// Chart Locker is a CommonJS Signal K plugin, while chart-sources 0.3.x intentionally exposes an
// ESM-only runtime. Dynamic import is preserved by the NodeNext build and crosses that boundary.
const chartSources = import('signalk-chart-sources')

export interface TilecacheConfigPayload {
  sources: readonly ChartSource[]
  publicBase: string
  capBytes: number
  regionsBudgetBytes: number
  positionWarmBudgetBytes: number
  scrollTtlSecs: number
  geocodingEnabled: boolean
}

/**
 * The v1 allowlist is the shared registry alone. Signal K chart resources are NOT included: a chart
 * resource may point at a LAN tile server that the container's SSRF guard blocks, and no v1 render
 * path proxies chart resources. Chart-resource proxying is a later sub-milestone.
 *
 * The cache cap and the two pinned budgets (R, the saved-regions reserve, and P, the position-warm
 * slice of R) are computed by the caller from config and carried here so the container's hard-reserved
 * two-budget accounting is non-zero. Without this push the container's regions budget stays 0 and every
 * region warm immediately caps.
 */
export async function buildSourcePayload (
  capBytes: number,
  regionsBudgetBytes: number,
  positionWarmBudgetBytes: number,
  scrollTtlSecs: number,
  geocodingEnabled: boolean = true,
  publicBase: string = PLUGIN_PUBLIC_BASE
): Promise<TilecacheConfigPayload> {
  const { CHART_SOURCES } = await chartSources
  return { sources: CHART_SOURCES, publicBase, capBytes, regionsBudgetBytes, positionWarmBudgetBytes, scrollTtlSecs, geocodingEnabled }
}

export type PostJson = (url: string, body: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<Response>
export type Delay = (ms: number, signal?: AbortSignal) => Promise<void>

export interface TilecacheConfigPushResult {
  ok: boolean
  status?: number
  error?: string
}

interface PushOptions {
  controlToken: string
  postJson?: PostJson
  delay?: Delay
  signal?: AbortSignal
}

const defaultDelay: Delay = async (ms, signal) => {
  if (signal?.aborted === true) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const aborted = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    function done (): void {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted === true) aborted()
  })
}

// A recreated container (a version bump changes the image tag, see tilecache-container.ts) can take
// a few seconds longer to start accepting connections than a warm restart, especially the first time
// a new image layer needs pulling. doStart calls this exactly once per plugin start with no caller-side
// retry, so a push that lands in that boot window failed outright and left the container's source
// allowlist and regions/position-warm budget accounting at zero until the next restart happened to win
// the race. Three attempts with linear backoff (1s, 2s) covers that window without a caller-side retry.
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

/** Push the source allowlist to the container, retrying a transient failure (the container not yet
 * accepting connections right after it starts) with linear backoff. Returns true on a 2xx from any
 * attempt, or a structured failure once retries are exhausted or a deterministic rejection arrives. */
export async function pushTilecacheConfig (
  address: string,
  payload: TilecacheConfigPayload,
  options: PushOptions
): Promise<TilecacheConfigPushResult> {
  const postJson = options.postJson ?? ((url, body, headers, signal) => fetch(url, { method: 'POST', headers, body, signal }))
  const delay = options.delay ?? defaultDelay
  const url = `http://${address}/config`
  const body = JSON.stringify(payload)
  const headers = { 'content-type': 'application/json', ...controlHeaders(options.controlToken) }
  const isAborted = (): boolean => options.signal?.aborted === true
  let lastError = 'tilecache unreachable'
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (isAborted()) return { ok: false, error: 'tilecache configuration cancelled' }
    try {
      const response = await postJson(url, body, headers, containerFetchSignal(options.signal))
      if (response.ok) return { ok: true, status: response.status }
      const status = response.status
      const detail = (await readBoundedResponseText(response, MAX_MANAGED_CONTAINER_ERROR_BYTES).catch(() => '')).slice(0, 500)
      lastError = `tilecache rejected config${status === undefined ? '' : ` with HTTP ${status}`}${detail === '' ? '' : `: ${detail}`}`
      const transient = status === undefined || status === 408 || status === 429 || status >= 500
      if (!transient) return { ok: false, status, error: lastError }
    } catch {
      if (isAborted()) return { ok: false, error: 'tilecache configuration cancelled' }
      // A thrown fetch (connection refused, timeout) is the boot-window race this retry exists for;
      // fall through to the backoff below rather than failing on the first attempt.
    }
    if (attempt < MAX_RETRIES - 1) {
      try {
        await delay(RETRY_DELAY_MS * (attempt + 1), options.signal)
      } catch {
        if (isAborted()) return { ok: false, error: 'tilecache configuration cancelled' }
      }
    }
  }
  return { ok: false, error: lastError }
}
