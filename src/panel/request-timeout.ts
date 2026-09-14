/**
 * The per-request timeouts for panel HTTP requests.
 *
 * Two budgets, because reads and writes fail in different ways.
 */

/**
 * The default, used by every read: the status poll, the cache statistics poll, cache-info, and the
 * chart listing.
 *
 * The binding constraint is the poller's: the timeout must stay below its 5 s poll interval so a
 * hung status request clears before the next tick rather than letting requests pile up.
 */
export const PANEL_REQUEST_TIMEOUT_MS = 4000

/**
 * The budget for an operator-initiated maintenance write: a chart rescan or a cache clear.
 *
 * These are unbounded server-side work, not polls. A rescan reads and validates every PMTiles
 * header in the charts directory, up to thousands of files, and clearing a large scroll cache has
 * the same shape, so on SD-card storage either can run well past a poll's budget. Nothing queues
 * behind them, because the panel already refuses a second action while one is in flight, so they
 * only need a bound loose enough that hitting it means the route is genuinely unresponsive.
 */
export const PANEL_MUTATION_TIMEOUT_MS = 60_000
