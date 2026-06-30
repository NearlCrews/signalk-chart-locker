/** Builds the managed tilecache container config (the one internet-egress container), launches it via the manager, and probes its health. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContainerConfig } from '../shared/types.js'
import { makeContainerHealthcheck, probeContainerHealth, type FetchLike } from './container-health.js'

export type { FetchLike }

export const TILECACHE_CONTAINER_NAME = 'chart-locker-tilecache'
export const TILECACHE_INTERNAL_PORT = 8080
export const DEFAULT_TILECACHE_IMAGE = 'ghcr.io/nearlcrews/signalk-chart-locker-tilecache'

/** The plugin version, read from the package's own package.json at module load. */
function packageVersion (): string {
  // __dirname is dist/runtime at runtime, so ../../package.json is the package root. npm always ships
  // package.json regardless of the files array. Throw a path-named error rather than an opaque ENOENT.
  const path = join(__dirname, '../../package.json')
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
  } catch (e) {
    throw new Error(`chart-locker: cannot read ${path} to derive the tilecache image tag: ${String(e)}`)
  }
}

/** Pin the image tag to the plugin version (for example "v0.3.0"), so each release changes the tag
 * string and forces signalk-container to recreate the container, which is the only reliable way to
 * ship container-side code to existing installs (a rebuilt floating ":latest" is never recreated). */
export const DEFAULT_TILECACHE_TAG = `v${packageVersion()}`

/** Where signalk-container mounts the Signal K data directory inside the container (the durable default). */
const SIGNALK_DATA_MOUNT = '/signalk-data'
/** The cache subdirectory under the data mount, and the DB file in it. A user-managed external volume can mount here. */
const CACHE_DIR = `${SIGNALK_DATA_MOUNT}/chart-locker-tilecache`
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
  /** Cache byte cap; defaults to 8 GiB. */
  capBytes?: number
  /** Scroll-tile TTL in seconds, seeded into the container env so the startup sweep has a value. */
  scrollTtlSecs?: number
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
      TILECACHE_CAP_BYTES: String(cap),
      TILECACHE_SCROLL_TTL_SECS: String(opts.scrollTtlSecs ?? 0)
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
