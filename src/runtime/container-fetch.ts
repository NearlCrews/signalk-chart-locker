/** The bound on control-plane fetches to the tilecache container (health, configuration, statistics,
 *  and warming). A slow or hung container endpoint then fails fast with a caught error instead of
 *  hanging the caller, the position-warm loop, a health probe, or plugin startup. Shared so every
 *  container caller uses the same ceiling, and none is left unbounded. */
export const CONTAINER_FETCH_TIMEOUT_MS = 8000

/** The bound on browser-facing tile and style streams. A cold viewport queues dozens of tiles behind
 *  the container's bounded admission while slow WMS upstreams drain at the egress rate, so these
 *  streams must outlast the container's admission wait plus its upstream fetch ceiling; the fast
 *  control-plane bound would abort queued tiles that were about to serve and turn them into chart
 *  holes. A hung endpoint cannot pin a stream for the full minute in practice: the browser cancels
 *  tile requests on every pan and zoom, and the proxy propagates that cancel. */
export const TILE_STREAM_TIMEOUT_MS = 60_000

/** Combine a caller lifecycle signal with the per-request container timeout. */
export function containerFetchSignal (signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}
