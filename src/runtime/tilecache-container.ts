/** Builds the managed tilecache container config (the one internet-egress container), launches it via the manager, and probes its health. */

import type { ContainerConfig, FetchResponse } from '../shared/types.js'

export const TILECACHE_CONTAINER_NAME = 'binnacle-tilecache'
export const TILECACHE_INTERNAL_PORT = 8080
export const DEFAULT_TILECACHE_IMAGE = 'ghcr.io/nearlcrews/signalk-binnacle-tilecache'
export const DEFAULT_TILECACHE_TAG = 'latest'

/** Where signalk-container mounts the Signal K data directory inside the container (the durable default). */
const SIGNALK_DATA_MOUNT = '/signalk-data'
/** The cache subdirectory under the data mount, and the DB file in it. A user-managed external volume can mount here. */
const CACHE_DIR = `${SIGNALK_DATA_MOUNT}/binnacle-tilecache`
const TILECACHE_DB_PATH = `${CACHE_DIR}/cache.sqlite`
/** Conservative default cap (2 GiB), suitable for a microSD deployment. */
export const DEFAULT_CACHE_CAP_BYTES = 2_147_483_648

const TILECACHE_HEALTHCHECK = {
  test: ['CMD', '/tilecache', 'healthcheck'],
  interval: '30s',
  timeout: '5s',
  startPeriod: '15s',
  retries: 3
}

/** Smaller than the router: the proxy is mostly IO-bound. Equal memory and memorySwap disables swap; a high oomScoreAdj makes it die before Signal K. */
const TILECACHE_RESOURCES = {
  memory: '512m',
  memorySwap: '512m',
  cpus: 1,
  pidsLimit: 256,
  oomScoreAdj: 850
}

export interface TilecacheContainerOptions {
  image?: string
  tag?: string
  /** Cache byte cap; defaults to 2 GiB. */
  capBytes?: number
  /** Host path of a user-managed external volume (USB SSD or NVMe) to hold the cache; absent leaves it on the data mount. */
  externalCacheVolumeSource?: string
}

export function buildTilecacheConfig (opts: TilecacheContainerOptions = {}): ContainerConfig {
  const cap = opts.capBytes ?? DEFAULT_CACHE_CAP_BYTES
  const config: ContainerConfig = {
    image: opts.image ?? DEFAULT_TILECACHE_IMAGE,
    tag: opts.tag ?? DEFAULT_TILECACHE_TAG,
    signalkAccessiblePorts: [TILECACHE_INTERNAL_PORT],
    healthcheck: TILECACHE_HEALTHCHECK,
    resources: TILECACHE_RESOURCES,
    restart: 'unless-stopped',
    signalkDataMount: SIGNALK_DATA_MOUNT,
    env: {
      TILECACHE_DB: TILECACHE_DB_PATH,
      TILECACHE_CAP_BYTES: String(cap)
    }
  }
  if (opts.externalCacheVolumeSource !== undefined) {
    // Relocate the cache to an external SSD or NVMe; skip the mount if the drive is absent so the
    // container still starts (falling back to the data mount on the boot card).
    config.volumes = {
      [CACHE_DIR]: { source: opts.externalCacheVolumeSource, ifMissing: 'skip' }
    }
  }
  return config
}

export type FetchLike = (url: string) => Promise<FetchResponse>

export async function probeTilecacheHealth (address: string, fetchFn: FetchLike = (url: string) => fetch(url)): Promise<boolean> {
  try {
    const response = await fetchFn(`http://${address}/health`)
    if (!response.ok) return false
    const body = (await response.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}
