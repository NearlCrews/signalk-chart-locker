/** The bound on every fetch to the tilecache container. A slow or hung container endpoint then fails
 *  fast with a caught error instead of hanging the request, the position-warm loop, a health probe, or
 *  plugin startup. Shared so every container caller uses the same ceiling, and none is left unbounded. */
export const CONTAINER_FETCH_TIMEOUT_MS = 8000

/** Combine a caller lifecycle signal with the per-request container timeout. */
export function containerFetchSignal (signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}
