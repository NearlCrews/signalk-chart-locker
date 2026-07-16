/**
 * A controlled numeric field: a label, a number input backed by
 * `useNumberDraft` (so the field can be cleared mid-edit), and a paragraph of
 * hint text. Used for whole-number settings whose bounds, step, and fallback
 * are supplied by each call site.
 */

import type * as React from 'react'
import { LabeledField, NumberInput, type FieldErrorLive } from 'signalk-nearlcrews-ui'
import { useNumberDraft, type NumberDraftOptions } from '../hooks/use-number-draft.js'

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
  /** Validation message associated with the input. */
  error?: React.ReactNode
  /** How changes to the validation message are announced. */
  errorLive?: FieldErrorLive
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
  error,
  errorLive,
  min,
  max,
  integer,
  fallback
}: Props): React.ReactElement {
  const draft = useNumberDraft(value, onChange, { min, max, integer, fallback, step })

  return (
    <LabeledField
      label={label}
      description={hint}
      error={error}
      errorLive={errorLive}
      layout='inline'
    >
      <NumberInput
        id={id}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={draft.display}
        onChange={(event) => draft.handleChange(event.target.value)}
        onBlur={draft.handleBlur}
      />
    </LabeledField>
  )
}
