/**
 * Render a timestamp as a localized, relative phrase such as "5 seconds ago".
 * Used by the status bar's freshness note so an operator can tell a live
 * readout from a stalled one. Self-contained (no shared dependency) so it
 * bundles cleanly into the browser panel and is testable on its own.
 */

/**
 * Shared `RelativeTimeFormat` instance. Construction is non-trivial and the
 * formatter is reentrant, so it is reused across every call rather than rebuilt
 * per call (the status bar re-renders on each 5-second poll tick).
 */
const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/**
 * Render a timestamp (an ISO-8601 string, or epoch milliseconds) as a
 * localized, relative phrase. Picks the coarsest unit the magnitude reaches.
 * Relies on Intl.RelativeTimeFormat's built-in rollover (e.g., 60 minutes
 * formats as 1 hour) to avoid manual boundary math.
 */
export function relativeTime (at: string | number): string {
  const then = typeof at === 'number' ? at : new Date(at).getTime()
  if (Number.isNaN(then)) return String(at)

  const deltaSeconds = Math.round((then - Date.now()) / 1000)
  const absSeconds = Math.abs(deltaSeconds)

  const unit: Intl.RelativeTimeFormatUnit = absSeconds >= 86_400 ? 'day'
    : absSeconds >= 3_600 ? 'hour'
    : absSeconds >= 60 ? 'minute'
    : 'second'

  const secondsPerUnit = unit === 'day' ? 86_400
    : unit === 'hour' ? 3_600
    : unit === 'minute' ? 60
    : 1

  return RELATIVE_TIME_FORMAT.format(Math.round(deltaSeconds / secondsPerUnit), unit)
}
