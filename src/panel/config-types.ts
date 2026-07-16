/**
 * The configuration shape the panel reads and writes, plus the bounds and
 * defaults that shape it. Kept React-free so it can be imported by the
 * reducer, the normalizer, and their unit tests.
 *
 * The shape mirrors the grouped schema the plugin declares in
 * `src/plugin/plugin.ts` exactly, so a save from the panel round-trips with
 * the plugin's own readers. The values are stored in the plugin's own units
 * (whole GiB for the cache sizes, a filesystem path or image tag string for
 * the rest); no conversion happens in the panel.
 */

/** The tile cache group: the on-disk cache cap and the saved-regions reserve. */
export interface TileCacheConfig {
  /** The most disk space, in whole GiB, the tile cache may use. */
  cacheCapGiB: number
  /** A ceiling, in whole GiB, on how much of the cache saved regions may pin. 0 means reserve half the cap. */
  regionsBudgetGiB: number
}

/** The charts group: where the plugin looks for local PMTiles charts. */
export interface ChartsConfig {
  /** Directory holding .pmtiles charts, relative to the Signal K config path. Blank means the default. */
  path: string
}

/** The advanced group: settings most installs never change. */
export interface AdvancedConfig {
  /** Whether place-name lookup may contact the configured geocoding provider. */
  geocodingEnabled: boolean
  /** The container image tag to run. Blank keeps the tag pinned to the plugin version. */
  imageTag: string
  /** Host path of an external drive to hold the cache. Blank keeps the cache on the data directory. */
  cacheVolumeSource: string
}

/** The full plugin configuration, grouped exactly as the plugin schema groups it. */
export interface ChartLockerConfig {
  tileCache: TileCacheConfig
  charts: ChartsConfig
  advanced: AdvancedConfig
}

// The cache-cap bounds and step come from the shared cache-cap module, so the panel field, the
// plugin schema, and the cache-info route never drift. The static default (used when the plugin has
// never been configured and before the cache-info route responds) is the same fallback the runtime
// uses when free-space detection is unavailable; the panel seeds a free-space-aware value over it
// once the route responds.
export {
  CACHE_CAP_MAX_GIB,
  CACHE_CAP_MIN_GIB,
  CACHE_CAP_STEP_GIB,
  CACHE_CAP_STATIC_DEFAULT_GIB as CACHE_CAP_DEFAULT_GIB
} from '../shared/cache-cap.js'

/** Smallest saved-regions budget the plugin accepts, in GiB. 0 means reserve half the cap. */
export const REGIONS_BUDGET_MIN_GIB = 0
/** The panel's default saved-regions budget, in GiB. Mirrors the schema default. */
export const REGIONS_BUDGET_DEFAULT_GIB = 0
