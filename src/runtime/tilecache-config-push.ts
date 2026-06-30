/** Builds the tilecache POST /config payload from the shared source registry and pushes it to the container. */

import { CHART_SOURCES, type ChartSource } from 'signalk-chart-sources'
import type { FetchResponse } from '../shared/types.js'

/** The Signal K server route base the browser reaches the proxy through (for the container style rewrite). */
export const PLUGIN_PUBLIC_BASE = '/plugins/signalk-chart-locker'

export interface TilecacheConfigPayload {
  sources: ChartSource[]
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
export function buildSourcePayload (
  capBytes: number,
  regionsBudgetBytes: number,
  positionWarmBudgetBytes: number,
  scrollTtlSecs: number,
  publicBase: string = PLUGIN_PUBLIC_BASE
): TilecacheConfigPayload {
  return { sources: CHART_SOURCES, publicBase, capBytes, regionsBudgetBytes, positionWarmBudgetBytes, scrollTtlSecs }
}

export type PostJson = (url: string, body: string) => Promise<FetchResponse>

/** Push the source allowlist to the container. Returns true on a 2xx, false on any failure. */
export async function pushTilecacheConfig (
  address: string,
  payload: TilecacheConfigPayload,
  postJson: PostJson = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
): Promise<boolean> {
  try {
    const response = await postJson(`http://${address}/config`, JSON.stringify(payload))
    return response.ok
  } catch {
    return false
  }
}
