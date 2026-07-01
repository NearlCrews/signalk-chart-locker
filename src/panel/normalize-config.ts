/**
 * Coercion of the admin UI's untyped `configuration` prop into a fully
 * populated ChartLockerConfig. Kept React-free so it can be unit-tested
 * directly.
 *
 * The clamps mirror the plugin schema bounds so the panel shows the value the
 * runtime will actually use: an out-of-range or non-numeric stored value falls
 * back to its schema default rather than reaching the container unclamped.
 */

import {
  CACHE_CAP_DEFAULT_GIB,
  CACHE_CAP_MAX_GIB,
  CACHE_CAP_MIN_GIB,
  REGIONS_BUDGET_DEFAULT_GIB,
  REGIONS_BUDGET_MIN_GIB,
  type ChartLockerConfig
} from './config-types.js'

/** The raw object shape read out of the untyped configuration prop. */
type RawGroup = Record<string, unknown> | undefined

/** Read a group object off the raw config, or undefined when it is absent or not an object. */
function group (raw: Record<string, unknown>, key: string): RawGroup {
  const value = raw[key]
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Coerce a value to a whole number clamped to `[min, max]`, falling back to
 * `fallback` when it is not a finite number. A fractional value is truncated,
 * matching the plugin's integer schema fields.
 */
export function clampIntGiB (
  value: unknown, min: number, max: number, fallback: number
): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  let next = Math.trunc(parsed)
  if (next < min) next = min
  if (next > max) next = max
  return next
}

/** Read a trimmed string off the raw group, or '' when it is absent or not a string. */
function readString (raw: RawGroup, key: string): string {
  const value = raw?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Coerce the admin UI's untyped `configuration` prop into a fully populated
 * ChartLockerConfig. A never-configured plugin (null or undefined prop) yields
 * the schema defaults, so the panel opens on the values the plugin would use.
 */
export function normalizeConfig (configuration: unknown): ChartLockerConfig {
  const raw = (typeof configuration === 'object' && configuration !== null)
    ? configuration as Record<string, unknown>
    : {}

  const tileCache = group(raw, 'tileCache')
  const charts = group(raw, 'charts')
  const advanced = group(raw, 'advanced')

  return {
    tileCache: {
      cacheCapGiB: clampIntGiB(
        tileCache?.cacheCapGiB, CACHE_CAP_MIN_GIB, CACHE_CAP_MAX_GIB, CACHE_CAP_DEFAULT_GIB
      ),
      // No upper bound: the plugin clamps a budget above the cache cap down to
      // the cap at start, so the panel accepts any non-negative whole number.
      regionsBudgetGiB: clampIntGiB(
        tileCache?.regionsBudgetGiB,
        REGIONS_BUDGET_MIN_GIB,
        Number.MAX_SAFE_INTEGER,
        REGIONS_BUDGET_DEFAULT_GIB
      )
    },
    charts: {
      path: readString(charts, 'path')
    },
    advanced: {
      imageTag: readString(advanced, 'imageTag'),
      cacheVolumeSource: readString(advanced, 'cacheVolumeSource')
    }
  }
}
