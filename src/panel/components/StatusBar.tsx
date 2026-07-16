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
import { memo, useEffect, useState } from 'react'
import { Section, StatusIndicator } from 'signalk-nearlcrews-ui'
import type { PluginRuntimeStatus } from '../hooks/use-status.js'
import { relativeTime } from '../relative-time.js'
import styles from '../PluginConfigurationPanel.module.css'

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
  // Re-render on a slow tick so the "checked N ago" note keeps advancing during an outage, when no new
  // poll changes the props. relativeTime steps in minutes, so a 30 s cadence keeps it honest cheaply.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (lastUpdatedMs === null) return
    const id = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(id)
  }, [lastUpdatedMs])
  return (
    <Section
      title='Plugin status'
      actions={lastUpdatedMs !== null
        ? <span className={styles.secondaryText}>Checked {relativeTime(lastUpdatedMs)}</span>
        : undefined}
    >
      {status === null
        ? <StatusIndicator tone='neutral' role='status' aria-live='polite'>Loading status...</StatusIndicator>
        : <StatusLine status={status} />}
    </Section>
  )
})

/** The dot plus the status line: the plugin's message, or a derived fallback. */
function StatusLine ({ status }: { status: PluginRuntimeStatus }): React.ReactElement {
  const { enabled, statusMessage } = status
  if (statusMessage !== '') {
    return (
      <StatusIndicator tone={enabled ? 'success' : 'neutral'} role='status' aria-live='polite'>{statusMessage}</StatusIndicator>
    )
  }
  return enabled
    ? <StatusIndicator tone='success' role='status' aria-live='polite'>Plugin enabled.</StatusIndicator>
    : <StatusIndicator tone='neutral' role='status' aria-live='polite'>Plugin disabled. Enable it above to start the tile cache.</StatusIndicator>
}
