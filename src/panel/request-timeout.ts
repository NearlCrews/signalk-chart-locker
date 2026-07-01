/**
 * The panel-wide per-request timeout, shared by the status poller and the one-shot cache-info fetch.
 *
 * The binding constraint is the poller's: the timeout must stay below its 5 s poll interval so a
 * hung request clears before the next tick rather than letting requests pile up. The one-shot
 * cache-info fetch reuses it so both panel requests bound their wait the same way.
 */
export const PANEL_REQUEST_TIMEOUT_MS = 4000
