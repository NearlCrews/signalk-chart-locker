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

/** Smallest cache cap the plugin accepts, in GiB. Mirrors the schema minimum. */
export const CACHE_CAP_MIN_GIB = 1
/** Largest cache cap the plugin accepts, in GiB. Mirrors the schema maximum. */
export const CACHE_CAP_MAX_GIB = 1024
/**
 * The panel's fallback cache cap, in GiB, when the plugin has never been
 * configured. The plugin's own schema seeds a larger default from the free
 * space it detects at load time, but the panel cannot read the data-directory
 * filesystem, so it falls back to the plugin's static default (8 GiB). Mirrors
 * DEFAULT_CACHE_CAP_GIB in src/runtime/tilecache-container.ts.
 */
export const CACHE_CAP_DEFAULT_GIB = 8

/** Smallest saved-regions budget the plugin accepts, in GiB. 0 means reserve half the cap. */
export const REGIONS_BUDGET_MIN_GIB = 0
/** The panel's default saved-regions budget, in GiB. Mirrors the schema default. */
export const REGIONS_BUDGET_DEFAULT_GIB = 0
