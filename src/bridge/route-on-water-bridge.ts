/** Publishes the route-on-water bridge on globalThis so in-process callers (crows-nest) reach the router without HTTP. */

import type { RouteOnWaterBridge } from '../shared/types.js'

export const BRIDGE_GLOBAL_KEY = '__signalk_binnacle_routeOnWater'

export function installRouteOnWaterBridge (bridge: RouteOnWaterBridge): void {
  ;(globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY] = bridge
}

export function removeRouteOnWaterBridge (): void {
  delete (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY]
}

export function getRouteOnWaterBridge (): RouteOnWaterBridge | undefined {
  return (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY] as RouteOnWaterBridge | undefined
}

/**
 * Milestone 1 stub. Readiness resolves immediately; routeOnWater reports that real
 * routing is not implemented yet, distinguishing a healthy container from an
 * unreachable one. The cutover milestone replaces this with the real implementation
 * that posts the request to the container and returns its ChannelRouteResult.
 */
export function createSkeletonBridge (
  address: string,
  probe: (address: string) => Promise<boolean>
): RouteOnWaterBridge {
  return {
    async whenReady () {},
    async routeOnWater () {
      const healthy = await probe(address)
      return { ok: false, reason: healthy ? 'not-implemented' : 'router-unavailable' }
    }
  }
}
