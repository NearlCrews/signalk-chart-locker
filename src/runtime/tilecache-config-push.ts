/** Builds the tilecache POST /config payload from the shared source registry and pushes it to the container. */

import type { ChartSource } from 'signalk-chart-sources'
import type { FetchResponse } from '../shared/types.js'
import { CONTAINER_FETCH_TIMEOUT_MS } from './container-fetch.js'
import { PLUGIN_MOUNT_PATH } from '../shared/plugin-id.js'

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
  publicBase: string = PLUGIN_PUBLIC_BASE
): Promise<TilecacheConfigPayload> {
  const { CHART_SOURCES } = await chartSources
  return { sources: CHART_SOURCES, publicBase, capBytes, regionsBudgetBytes, positionWarmBudgetBytes, scrollTtlSecs }
}

export type PostJson = (url: string, body: string) => Promise<FetchResponse>
export type Delay = (ms: number) => Promise<void>

const defaultDelay: Delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
 * attempt, false once every attempt has failed. */
export async function pushTilecacheConfig (
  address: string,
  payload: TilecacheConfigPayload,
  postJson: PostJson = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS) }),
  delay: Delay = defaultDelay
): Promise<boolean> {
  const url = `http://${address}/config`
  const body = JSON.stringify(payload)
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await postJson(url, body)
      if (response.ok) return true
    } catch {
      // A thrown fetch (connection refused, timeout) is the boot-window race this retry exists for;
      // fall through to the backoff below rather than failing on the first attempt.
    }
    if (attempt < MAX_RETRIES - 1) await delay(RETRY_DELAY_MS * (attempt + 1))
  }
  return false
}
