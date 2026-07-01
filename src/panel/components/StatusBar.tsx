/**
 * Live status bar: a small bordered card at the top of the panel that shows
 * the plugin's published status line (for example "Tilecache at
 * 127.0.0.1:8080") and whether the plugin is enabled, plus how fresh the
 * readout is. Driven entirely by the status polled from the server's plugin
 * list.
 *
 * When the server exposes no status message, the bar degrades to a line
 * derived from the enabled state, so it is always informative even before the
 * plugin has published anything.
 */

import type * as React from 'react'
import { memo } from 'react'
import type { PluginRuntimeStatus } from '../hooks/use-status.js'
import { relativeTime } from '../relative-time.js'
import { S } from '../styles.js'

// The dot base merged with each state variant once at module load, rather than
// rebuilding the merged object on every render.
const DOT_OK: React.CSSProperties = { ...S.dot, ...S.dotOk }
const DOT_OFF: React.CSSProperties = { ...S.dot, ...S.dotOff }

interface Props {
  /** The latest plugin status, or null until the first poll resolves. */
  status: PluginRuntimeStatus | null
  /**
   * Epoch milliseconds of the most recent successful status poll, or null.
   * Renders as a "checked Ns ago" note so the operator can tell a live
   * readout from a stalled one.
   */
  lastUpdatedMs: number | null
}

/**
 * The status bar shown at the top of the configuration panel. Memoized: the
 * `status` prop keeps stable identity between unchanged polls and
 * `lastUpdatedMs` changes only on the 5 s poll tick, so a keystroke elsewhere
 * on the panel does not re-run the relative-time formatting.
 */
export default memo(function StatusBar ({ status, lastUpdatedMs }: Props): React.ReactElement {
  return (
    <div style={S.statusBar}>
      <div style={S.statusTitleRow}>
        <span style={S.statusBarTitle}>Plugin status</span>
        {lastUpdatedMs !== null
          ? (
            <span style={S.statusCheckedAt}>
              checked {relativeTime(lastUpdatedMs)}
            </span>
            )
          : null}
      </div>
      {status === null
        ? (
          <span style={S.statusBarLoading}>
            <span style={DOT_OFF} aria-hidden='true' />
            Loading status...
          </span>
          )
        : <StatusLine status={status} />}
    </div>
  )
})

/** The dot plus the status line: the plugin's message, or a derived fallback. */
function StatusLine ({ status }: { status: PluginRuntimeStatus }): React.ReactElement {
  const { enabled, statusMessage } = status
  if (statusMessage !== '') {
    return (
      <div style={S.statusRow}>
        <span style={enabled ? DOT_OK : DOT_OFF} aria-hidden='true' />
        <span style={S.statusMessage}>{statusMessage}</span>
      </div>
    )
  }
  return (
    <div style={S.statusRow}>
      <span style={enabled ? DOT_OK : DOT_OFF} aria-hidden='true' />
      {enabled
        ? <span style={S.statusMessage}>Plugin enabled.</span>
        : <span style={S.statusMessageMuted}>Plugin disabled. Enable it above to start the tile cache.</span>}
    </div>
  )
}
