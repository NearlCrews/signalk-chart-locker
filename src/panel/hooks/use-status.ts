/**
 * React hook that polls the Signal K server's plugin list for this plugin's
 * live status. It runs inside the admin's authenticated session, so the
 * same-origin request is transparently authorized. Polling pauses while the
 * document is hidden and resumes immediately when it becomes visible again, so
 * a backgrounded admin tab makes no needless requests.
 *
 * The server exposes each plugin's `statusMessage` (the string the plugin
 * publishes through `app.setPluginStatus`) and its enabled state on the admin
 * `GET /plugins` route. The plugin has no custom status endpoint, so this hook
 * reads the standard list and degrades gracefully: when a status message is
 * present it is shown verbatim, and when it is absent the bar falls back to the
 * plugin's enabled state.
 */

import { useEffect, useRef, useState } from 'react'
import { PLUGIN_ID } from '../../shared/plugin-id.js'
import { PANEL_AGE_TICK_MS } from '../age-tick.js'
import { useAbortableFetch } from './use-abortable-fetch.js'

/** The admin plugin-list route. Same-origin, gated by the admin session. */
const PLUGINS_URL = '/plugins'

/** How often, in milliseconds, to poll while the tab is visible. */
const POLL_INTERVAL_MS = 5000

/** The live plugin status the panel consumes. */
export interface PluginRuntimeStatus {
  /** Whether the plugin is currently enabled. */
  enabled: boolean
  /**
   * The status line the plugin published (for example "Tilecache at
   * 127.0.0.1:8080"), or an empty string when the server exposes none. When
   * empty the status bar derives a line from `enabled` instead.
   */
  statusMessage: string
}

/** The status surface the panel consumes. */
export interface UseStatusResult {
  /** The most recent status, or null until the first poll succeeds. */
  status: PluginRuntimeStatus | null
  /** A non-fatal message describing the last failed poll, or null. */
  error: string | null
  /** Epoch milliseconds of the most recent successful poll, or null before the first. */
  lastUpdatedMs: number | null
}

/** One entry in the admin plugin list, narrowed to the fields the panel reads. */
interface PluginListEntry {
  id?: unknown
  statusMessage?: unknown
  data?: { enabled?: unknown } | null
}

/** Pull this plugin's status out of the raw `GET /plugins` array, or null when it is absent. */
function extractStatus (body: unknown): PluginRuntimeStatus | null {
  if (!Array.isArray(body)) return null
  const entry = (body as PluginListEntry[]).find((p) => p?.id === PLUGIN_ID)
  if (entry === undefined) return null
  const statusMessage = typeof entry.statusMessage === 'string' ? entry.statusMessage.trim() : ''
  const enabled = entry.data?.enabled === true
  return { enabled, statusMessage }
}

/** Poll the admin plugin list and expose this plugin's latest status. */
export function useStatus (): UseStatusResult {
  const [status, setStatus] = useState<PluginRuntimeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | null>(null)
  const inFlight = useRef(false)
  // The JSON of the last status we committed to state, so a byte-identical
  // poll is detected without re-rendering: the status object keeps stable
  // identity across unchanged polls.
  const lastStatusJson = useRef<string | null>(null)
  // The timestamp last committed to state, so an unchanged poll can skip that
  // commit too. Without it the dedupe above buys nothing: a fresh timestamp on
  // every poll re-renders the whole panel regardless.
  const lastCommittedMs = useRef<number | null>(null)
  const fetcher = useAbortableFetch()

  useEffect(() => {
    // poll never rejects: it catches its own failures and surfaces them
    // through setError, so callers can leave its promise unhandled.
    async function poll (): Promise<void> {
      // Skip if a previous poll is still running, so a slow endpoint cannot
      // stack overlapping requests whose responses then arrive out of order.
      if (inFlight.current) {
        return
      }
      inFlight.current = true
      try {
        const parsed = await fetcher.fetchJson(PLUGINS_URL)
        const next = extractStatus(parsed)
        if (next === null) {
          throw new Error('plugin not found in the server plugin list')
        }
        if (!fetcher.canceled()) {
          // Skip the state update when the status is byte-identical to the
          // last one committed, so the panel does not re-render once per
          // 5 s for no user-visible change.
          const json = JSON.stringify(next)
          const changed = lastStatusJson.current !== json
          if (changed) {
            lastStatusJson.current = json
            setStatus(next)
          }
          // The freshness note re-reads the clock on the shared panel tick and
          // is spelled in whole units, so a timestamp committed more often than
          // that changes nothing on screen while re-rendering the whole panel.
          // Commit on a real status change, and otherwise only once the note
          // itself could have moved, which leaves the age it shows no staler
          // than the note's own resolution and never fresher than the truth.
          const now = Date.now()
          const committed = lastCommittedMs.current
          if (changed || committed === null || now - committed >= PANEL_AGE_TICK_MS) {
            lastCommittedMs.current = now
            setLastUpdatedMs(now)
          }
          setError(null)
        }
      } catch (e) {
        if (!fetcher.abandoned(e)) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        inFlight.current = false
      }
    }

    poll()
    const intervalId = setInterval(() => {
      if (!document.hidden) poll()
    }, POLL_INTERVAL_MS)

    // A poll skipped while hidden would otherwise leave stale data on screen
    // until the next interval; refresh as soon as the tab is shown again.
    const onVisibilityChange = (): void => {
      if (!document.hidden) poll()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [fetcher])

  return { status, error, lastUpdatedMs }
}
