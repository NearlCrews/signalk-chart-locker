/** Builds the managed router container config, launches it via the manager, and probes its health endpoint. */

import type { ContainerConfig } from '../shared/types.js'

export const ROUTER_CONTAINER_NAME = 'binnacle-router'
export const ROUTER_INTERNAL_PORT = 8080
export const DEFAULT_ROUTER_IMAGE = 'ghcr.io/nearlcrews/signalk-binnacle-router'
export const DEFAULT_ROUTER_TAG = 'latest'

/** Exec-form probe: distroless has no shell, so the binary checks its own liveness. */
const ROUTER_HEALTHCHECK = {
  test: ['CMD', '/router', 'healthcheck'],
  interval: '30s',
  timeout: '5s',
  startPeriod: '15s',
  retries: 3
}

/** Equal memory and memorySwap disables swap; a positive oomScoreAdj makes the router die before Signal K. */
const ROUTER_RESOURCES = {
  memory: '1g',
  memorySwap: '1g',
  cpus: 2,
  pidsLimit: 256,
  oomScoreAdj: 800
}

export interface RouterContainerOptions {
  image?: string
  tag?: string
}

export function buildRouterConfig (opts: RouterContainerOptions = {}): ContainerConfig {
  return {
    image: opts.image ?? DEFAULT_ROUTER_IMAGE,
    tag: opts.tag ?? DEFAULT_ROUTER_TAG,
    signalkAccessiblePorts: [ROUTER_INTERNAL_PORT],
    healthcheck: ROUTER_HEALTHCHECK,
    resources: ROUTER_RESOURCES,
    restart: 'unless-stopped'
  }
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>

export async function probeRouterHealth (address: string, fetchFn: FetchLike = (url: string) => fetch(url)): Promise<boolean> {
  try {
    const response = await fetchFn(`http://${address}/health`)
    if (!response.ok) return false
    const body = (await response.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}
