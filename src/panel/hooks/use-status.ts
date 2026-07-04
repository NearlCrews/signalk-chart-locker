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
import { PANEL_REQUEST_TIMEOUT_MS } from '../request-timeout.js'

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
  const canceled = useRef(false)
  const inFlight = useRef(false)
  // The JSON of the last status we committed to state, so a byte-identical
  // poll is detected without re-rendering: the status object keeps stable
  // identity across unchanged polls.
  const lastStatusJson = useRef<string | null>(null)

  useEffect(() => {
    canceled.current = false
    // Aborted on unmount so an outstanding request does not run to its
    // timeout against a component that is already gone.
    const unmountController = new AbortController()

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
        const response = await fetch(PLUGINS_URL, {
          credentials: 'same-origin',
          signal: AbortSignal.any([
            unmountController.signal,
            AbortSignal.timeout(PANEL_REQUEST_TIMEOUT_MS)
          ])
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const parsed: unknown = await response.json()
        const next = extractStatus(parsed)
        if (next === null) {
          throw new Error('plugin not found in the server plugin list')
        }
        if (!canceled.current) {
          // Skip the state update when the status is byte-identical to the
          // last one committed, so the panel does not re-render once per
          // 5 s for no user-visible change.
          const json = JSON.stringify(next)
          if (lastStatusJson.current !== json) {
            lastStatusJson.current = json
            setStatus(next)
          }
          setLastUpdatedMs(Date.now())
          setError(null)
        }
      } catch (e) {
        if (!canceled.current) {
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
      canceled.current = true
      unmountController.abort()
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  return { status, error, lastUpdatedMs }
}
