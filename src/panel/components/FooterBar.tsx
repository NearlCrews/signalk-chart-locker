/**
 * Panel footer: the Save and Discard controls plus a dirty / just-saved
 * indicator. Save is disabled for invalid configuration, or when the
 * configuration is unchanged and the plugin has already been configured.
 * When the plugin has never been saved, Save stays enabled so the user can
 * persist defaults without making a throwaway edit first.
 */

import type * as React from 'react'
import { memo, useRef } from 'react'
import { ActionBar, Button, StatusIndicator, type StatusTone } from 'signalk-nearlcrews-ui'
import { saveButtonDisabled } from '../footer-bar-state.js'

interface Props {
  dirty: boolean
  /**
   * True when the admin UI passed a null or undefined configuration prop,
   * meaning the plugin has never been saved. Save stays enabled in this
   * state so the user can persist defaults to enable the plugin.
   */
  unconfigured: boolean
  /** Epoch milliseconds of the last successful save, or null. Drives the temporary Saved status. */
  justSavedAt: number | null
  onSave: () => void
  onDiscard: () => void
  valid?: boolean
}

/**
 * The configuration panel's footer bar. Memoized: the panel root keeps the
 * two callbacks identity-stable, so field edits re-render the footer only when
 * its dirty, configured, validity, or saved-notice state changes.
 */
export default memo(function FooterBar ({ dirty, unconfigured, justSavedAt, onSave, onDiscard, valid = true }: Props): React.ReactElement {
  const saveDisabled = !valid || saveButtonDisabled(dirty, unconfigured)
  const statusRef = useRef<HTMLDivElement>(null)
  const statusTone: StatusTone = !valid
    ? 'danger'
    : dirty
      ? 'warning'
      : justSavedAt !== null
        ? 'success'
        : unconfigured
          ? 'info'
          : 'neutral'
  const statusText = !valid
    ? 'Fix validation errors before saving.'
    : dirty
      ? 'Unsaved changes'
      : justSavedAt !== null
        ? 'Saved'
        : unconfigured
          ? 'Save to enable the plugin.'
          : 'No unsaved changes'

  const runAndFocusStatus = (action: () => void): void => {
    action()
    window.requestAnimationFrame(() => statusRef.current?.focus())
  }

  return (
    <ActionBar
      sticky
      data-panel-action-bar=''
      statusRef={statusRef}
      status={
        <StatusIndicator
          tone={statusTone}
          role={valid ? 'status' : undefined}
          aria-live={valid ? 'polite' : 'off'}
        >
          {statusText}
        </StatusIndicator>
      }
      actions={
        <>
          <Button
            variant='primary'
            onClick={() => runAndFocusStatus(onSave)}
            disabled={saveDisabled}
          >
            Save
          </Button>
          <Button onClick={() => runAndFocusStatus(onDiscard)} disabled={!dirty}>
            Discard
          </Button>
        </>
      }
    />
  )
})
