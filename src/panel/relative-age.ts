/**
 * Age arithmetic for the panel's freshness notes.
 *
 * The shared `formatRelativeAge` takes a nonnegative elapsed age rather than a timestamp, and returns
 * its fallback for a negative one. Converting a timestamp is therefore the consumer's job, and it has
 * one edge worth owning: a host clock that steps backwards between a poll and a render would produce a
 * negative age and turn a perfectly good readout into "unknown". Clamping at the boundary keeps the
 * note honest as "now" until the clock catches up.
 *
 * Deliberately free of any `signalk-nearlcrews-ui` import: that package is ESM only, and this module
 * is reached by the CommonJS node test suite, which could not load it.
 */

/**
 * Elapsed milliseconds between a timestamp and now, never negative.
 *
 * @param timestampMs - Epoch milliseconds the reading was taken.
 * @param nowMs - Epoch milliseconds to measure against.
 */
export function ageMsSince (timestampMs: number, nowMs: number): number {
  return Math.max(0, nowMs - timestampMs)
}
