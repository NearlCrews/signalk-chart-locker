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
import { RelativeAge, Section, StatusIndicator, type StatusTone, Text } from 'signalk-nearlcrews-ui'
import { PANEL_AGE_TICK_MS } from '../age-tick.js'
import type { PluginRuntimeStatus } from '../hooks/use-status.js'

interface Props {
  /** The latest plugin status, or null until the first poll resolves. */
  status: PluginRuntimeStatus | null
  /**
   * Epoch milliseconds of the most recent successful status poll, or null.
   * Renders as a "Checked N minutes ago" note so the operator can tell a live
   * readout from a stalled one.
   */
  lastUpdatedMs: number | null
}

/**
 * The status bar shown at the top of the configuration panel. Memoized: the
 * `status` prop keeps stable identity between unchanged polls and
 * `lastUpdatedMs` changes only on the 5 s poll tick, so a keystroke elsewhere
 * on the panel does not re-render the bar.
 */
export default memo(function StatusBar ({ status, lastUpdatedMs }: Props): React.ReactElement {
  const { tone, text } = resolveStatusLine(status)
  return (
    <Section
      title='Plugin status'
      actions={lastUpdatedMs !== null
        ? <Text tone='muted' size='sm'>Checked <RelativeAge since={lastUpdatedMs} tickMs={PANEL_AGE_TICK_MS} /></Text>
        : undefined}
    >
      {/*
        * One status region for every branch, resolved as tone plus text rather than as a choice
        * between components. A live region has to exist before its text changes to be announced
        * reliably, and swapping element types at this position would unmount the loading region and
        * mount a fresh one at the moment the first poll resolves.
        */}
      <StatusIndicator tone={tone} live='polite'>{text}</StatusIndicator>
    </Section>
  )
})

/** The tone and words for the status line: the plugin's message, or a derived fallback. */
function resolveStatusLine (status: PluginRuntimeStatus | null): { tone: StatusTone, text: string } {
  if (status === null) return { tone: 'neutral', text: 'Loading status...' }
  const { enabled, statusMessage } = status
  if (statusMessage !== '') return { tone: enabled ? 'success' : 'neutral', text: statusMessage }
  return enabled
    ? { tone: 'success', text: 'Plugin enabled.' }
    : { tone: 'neutral', text: 'Plugin disabled. Enable it above to start the tile cache.' }
}
