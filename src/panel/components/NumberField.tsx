/**
 * A controlled numeric field: a label, a number input backed by
 * `useNumberDraft` (so the field can be cleared mid-edit), and a paragraph of
 * hint text. Used by the saved-regions budget, which is a plain whole-number
 * stepper with no upper bound.
 */

import type * as React from 'react'
import { useNumberDraft, type NumberDraftOptions } from '../hooks/use-number-draft.js'
import LabeledField from './LabeledField.js'
import { S } from '../styles.js'

interface Props extends NumberDraftOptions {
  /** Stable id linking the visible label to the input. */
  id: string
  /** Visible field label. */
  label: string
  /** Hint paragraph rendered below the input. */
  hint: React.ReactNode
  /** Committed value. */
  value: number
  /** Called with the clamped value on every keystroke. */
  onChange: (next: number) => void
  /** Disable the input. */
  disabled?: boolean
  /** Numeric step the up/down arrows use. */
  step?: number
}

/** A label + number input + hint row, with a draft-while-editing buffer. */
export default function NumberField ({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
  step,
  min,
  max,
  integer,
  fallback
}: Props): React.ReactElement {
  const draft = useNumberDraft(value, onChange, { min, max, integer, fallback })

  return (
    <LabeledField id={id} label={label} hint={hint}>
      {(controlProps) => (
        <input
          {...controlProps}
          type='number'
          min={min}
          max={max}
          step={step}
          style={S.input}
          disabled={disabled}
          value={draft.display}
          onChange={(e) => draft.handleChange(e.target.value)}
          onBlur={draft.handleBlur}
        />
      )}
    </LabeledField>
  )
}
