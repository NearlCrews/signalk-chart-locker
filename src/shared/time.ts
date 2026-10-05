/** Time helpers shared across the plugin so the same clock idiom is not rewritten per call site. */

/** The current time as whole Unix seconds, the resolution the regions store and its routes persist. */
export function nowUnixSecs (): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * A monotonic millisecond clock for measuring intervals: throttles, backoffs, cooldowns, and
 * self-heal cadences. A boat's wall clock can step when it is set from GPS after boot, and a backward
 * step measured on Date.now would hold an interval open for that long, while a forward step would
 * skip it. Never persist or compare these values across processes.
 */
export function monotonicNowMs (): number {
  return performance.now()
}
