/**
 * How often the panel's freshness readouts re-read the clock.
 *
 * Ages are spelled in words and step in minutes once they are past the first one, so a 30 s cadence
 * keeps them honest during an outage without re-rendering every few seconds. Every `RelativeAge` in
 * the panel passes this same value, which puts them all on one shared clock subscription.
 */
export const PANEL_AGE_TICK_MS = 30_000
