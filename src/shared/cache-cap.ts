/**
 * Cache-cap bounds and the free-space-to-default derivation, shared by the plugin runtime and the
 * federated configuration panel so a single definition governs the schema, the cache-info route, and
 * the panel field. This module is browser safe: it imports nothing from node, so the panel bundle can
 * import it without pulling node core in.
 */

/** Smallest cache cap the plugin accepts, in whole GiB. */
export const CACHE_CAP_MIN_GIB = 4
/** Largest cache cap the plugin accepts, in whole GiB. A tile cache larger than this is more than any
 *  realistic install needs, so the slider tops out here rather than at the free-space ceiling. */
export const CACHE_CAP_MAX_GIB = 32
/** The increment the cache-cap slider and stepper move by, in GiB. */
export const CACHE_CAP_STEP_GIB = 4
/** The cap used when free space cannot be detected, in GiB. A multiple of the step. */
export const CACHE_CAP_STATIC_DEFAULT_GIB = 8

/**
 * Round a value down to the nearest multiple of `step`, never below zero. A non-finite value or a
 * non-positive step yields 0, so callers clamp to the minimum afterward.
 */
export function floorToStep (value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return 0
  return Math.floor(value / step) * step
}

/**
 * Round a value to the nearest multiple of `step`. Used to align a stored or typed cap to the 5 GiB
 * grid so the slider and the number box agree. A non-finite value or a non-positive step yields 0.
 */
export function snapToStep (value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return 0
  return Math.round(value / step) * step
}

/**
 * The recommended cap for a filesystem with `freeGiB` free: about 80 percent of free space, floored
 * to the step to leave headroom, clamped to `[CACHE_CAP_MIN_GIB, CACHE_CAP_MAX_GIB]`. A non-finite
 * input yields the minimum. A large disk is capped at the maximum rather than reserving far more than
 * a tile cache needs.
 */
export function deriveDefaultCapGiB (freeGiB: number): number {
  if (!Number.isFinite(freeGiB)) return CACHE_CAP_MIN_GIB
  const floored = floorToStep(freeGiB * 0.8, CACHE_CAP_STEP_GIB)
  return Math.min(CACHE_CAP_MAX_GIB, Math.max(CACHE_CAP_MIN_GIB, floored))
}
