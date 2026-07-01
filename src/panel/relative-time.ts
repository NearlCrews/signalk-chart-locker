/**
 * Render a timestamp as a localized, relative phrase such as "5 seconds ago".
 * Used by the status bar's freshness note so an operator can tell a live
 * readout from a stalled one. Self-contained (no shared dependency) so it
 * bundles cleanly into the browser panel and is testable on its own.
 */

/** Relative-time units, largest first, paired with their length in seconds. */
const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1]
]

/**
 * Shared `RelativeTimeFormat` instance. Construction is non-trivial and the
 * formatter is reentrant, so it is reused across every call rather than rebuilt
 * per call (the status bar re-renders on each 5-second poll tick).
 */
const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/**
 * Render a timestamp (an ISO-8601 string, or epoch milliseconds) as a
 * localized, relative phrase. Picks the coarsest unit the magnitude reaches,
 * then steps up when rounding within that unit spills into the next unit up
 * (3599 s reads "1 hour", not "60 minutes").
 */
export function relativeTime (at: string | number): string {
  const then = typeof at === 'number' ? at : new Date(at).getTime()
  if (Number.isNaN(then)) return String(at)

  const deltaSeconds = Math.round((then - Date.now()) / 1000)
  const absSeconds = Math.abs(deltaSeconds)

  let index = RELATIVE_UNITS.length - 1
  for (let i = 0; i < RELATIVE_UNITS.length; i++) {
    if (absSeconds >= RELATIVE_UNITS[i][1]) {
      index = i
      break
    }
  }
  while (index > 0 &&
    Math.round(absSeconds / RELATIVE_UNITS[index][1]) * RELATIVE_UNITS[index][1] >= RELATIVE_UNITS[index - 1][1]) {
    index -= 1
  }

  const [unit, secondsPerUnit] = RELATIVE_UNITS[index]
  return RELATIVE_TIME_FORMAT.format(Math.round(deltaSeconds / secondsPerUnit), unit)
}
