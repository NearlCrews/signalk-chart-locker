/**
 * The per-request timeout for every panel HTTP request.
 *
 * The binding constraint is the poller's: the timeout must stay below its 5 s poll interval so a
 * hung status request clears before the next tick rather than letting requests pile up. Cache and
 * chart requests use the same bound so every panel operation recovers from an unresponsive route.
 */
export const PANEL_REQUEST_TIMEOUT_MS = 4000
