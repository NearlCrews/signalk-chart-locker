/** Publishes the route-on-water bridge on globalThis so in-process callers (crows-nest) reach the router without HTTP. */

import type { RouteOnWaterBridge, RouteOnWaterResult } from '../shared/types.js'

export const BRIDGE_GLOBAL_KEY = '__signalk_binnacle_routeOnWater'

const JSON_HEADERS = { 'content-type': 'application/json' } as const

export function installRouteOnWaterBridge (bridge: RouteOnWaterBridge): void {
  ;(globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY] = bridge
}

export function removeRouteOnWaterBridge (): void {
  delete (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY]
}

export function getRouteOnWaterBridge (): RouteOnWaterBridge | undefined {
  return (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY] as RouteOnWaterBridge | undefined
}

/** A POST-capable fetch, mirroring the GET-only FetchLike in router-container but carrying a request init. */
export type PostFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; json(): Promise<unknown> }>

/**
 * The route-on-water bridge over the router container. Readiness probes the container health
 * endpoint and resolves once healthy, leaving any unavailability for routeOnWater to surface.
 * routeOnWater posts the caller's request transparently to the container and returns its result.
 * The request is forwarded as-is, since the container owns its own request shape. The container
 * positions match the local Position type field names (latitude and longitude), so the waypoints
 * pass through without remapping. On any failure, that is a rejected fetch, a non-ok HTTP status,
 * or a JSON parse error, routeOnWater returns a router-unavailable decline rather than throwing or
 * fabricating a route.
 */
export function createRouterBridge (
  address: string,
  probe: (address: string) => Promise<boolean>,
  postFetch: PostFetch = (url, init) => fetch(url, init)
): RouteOnWaterBridge {
  return {
    async whenReady () {
      await probe(address)
    },
    async routeOnWater (request: unknown): Promise<RouteOnWaterResult> {
      try {
        const response = await postFetch(`http://${address}/route-on-water`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(request)
        })
        if (!response.ok) return { ok: false, reason: 'router-unavailable' }
        return (await response.json()) as RouteOnWaterResult
      } catch {
        return { ok: false, reason: 'router-unavailable' }
      }
    }
  }
}
