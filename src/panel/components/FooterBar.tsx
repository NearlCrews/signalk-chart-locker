/**
 * Panel footer: the Save and Discard controls plus a dirty / just-saved
 * indicator. Save is disabled when the configuration is unchanged AND the
 * plugin has already been configured at least once. When the plugin has never
 * been saved (unconfigured), Save stays enabled so the user can persist
 * defaults to enable the plugin without making a throwaway edit first.
 */

import type * as React from 'react'
import { memo } from 'react'
import SaveStatus from './SaveStatus.js'
import { saveButtonDisabled } from '../footer-bar-state.js'
import { S } from '../styles.js'

interface Props {
  dirty: boolean
  /**
   * True when the admin UI passed a null or undefined configuration prop,
   * meaning the plugin has never been saved. Save stays enabled in this
   * state so the user can persist defaults to enable the plugin.
   */
  unconfigured: boolean
  /** Epoch milliseconds of the last successful save, or null. Drives the "Saved" pill. */
  justSavedAt: number | null
  onSave: () => void
  onDiscard: () => void
}

/**
 * The configuration panel's footer bar. Memoized: the panel root keeps the
 * two callbacks identity-stable, so a keystroke in a field re-renders the
 * footer only when the dirty flag or unconfigured state actually flips.
 */
export default memo(function FooterBar ({ dirty, unconfigured, justSavedAt, onSave, onDiscard }: Props): React.ReactElement {
  const saveDisabled = saveButtonDisabled(dirty, unconfigured)
  return (
    <div style={S.footer}>
      <button type='button' style={S.btnPrimary} onClick={onSave} disabled={saveDisabled}>
        Save
      </button>
      <button type='button' style={S.btnSecondary} onClick={onDiscard} disabled={!dirty}>
        Discard
      </button>
      <SaveStatus dirty={dirty} justSavedAt={justSavedAt} />
      {unconfigured && !dirty
        ? <span style={S.hint}>Save to enable the plugin.</span>
        : null}
    </div>
  )
})
