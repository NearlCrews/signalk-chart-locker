/** Builds the managed router container config, launches it via the manager, and probes its health endpoint. */

import type { ContainerConfig } from '../shared/types.js'
import { makeContainerHealthcheck, probeContainerHealth, type FetchLike } from './container-health.js'

export type { FetchLike }

export const ROUTER_CONTAINER_NAME = 'binnacle-router'
export const ROUTER_INTERNAL_PORT = 8080
export const DEFAULT_ROUTER_IMAGE = 'ghcr.io/nearlcrews/signalk-binnacle-router'
export const DEFAULT_ROUTER_TAG = 'latest'

const ROUTER_HEALTHCHECK = makeContainerHealthcheck('/router')

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

export const probeRouterHealth = probeContainerHealth
