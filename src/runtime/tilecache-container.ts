/** Builds the managed tilecache container config (the one internet-egress container), launches it via the manager, and probes its health. */

import type { ContainerConfig } from '../shared/types.js'
import { makeContainerHealthcheck, probeContainerHealth, type FetchLike } from './container-health.js'

export type { FetchLike }

export const TILECACHE_CONTAINER_NAME = 'binnacle-tilecache'
export const TILECACHE_INTERNAL_PORT = 8080
export const DEFAULT_TILECACHE_IMAGE = 'ghcr.io/nearlcrews/signalk-binnacle-tilecache'
export const DEFAULT_TILECACHE_TAG = 'latest'

/** Where signalk-container mounts the Signal K data directory inside the container (the durable default). */
const SIGNALK_DATA_MOUNT = '/signalk-data'
/** The cache subdirectory under the data mount, and the DB file in it. A user-managed external volume can mount here. */
const CACHE_DIR = `${SIGNALK_DATA_MOUNT}/binnacle-tilecache`
const TILECACHE_DB_PATH = `${CACHE_DIR}/cache.sqlite`
/** Conservative default cap (GiB). Used as the fallback when free-space detection is unavailable. */
export const DEFAULT_CACHE_CAP_GIB = 8

const TILECACHE_HEALTHCHECK = makeContainerHealthcheck('/tilecache')

/** The proxy is mostly IO-bound. Equal memory and memorySwap disables swap; a high oomScoreAdj makes it die before Signal K. */
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
  const cap = opts.capBytes ?? DEFAULT_CACHE_CAP_GIB * 1024 ** 3
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

export const probeTilecacheHealth = probeContainerHealth
