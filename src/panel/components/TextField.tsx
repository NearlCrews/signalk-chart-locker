/**
 * A controlled free-text field: a label, a wide text input, and a hint. Used
 * by the charts directory, the container image tag, and the external cache
 * drive path. It commits every keystroke and applies no clamping; blank is a
 * meaningful value for each of these fields (it selects the plugin's default),
 * so the raw string is passed straight through.
 */

import type * as React from 'react'
import LabeledField from './LabeledField.js'
import { S } from '../styles.js'

interface Props {
  /** Stable id linking the visible label to the input. */
  id: string
  /** Visible field label. */
  label: string
  /** Hint paragraph rendered below the input. */
  hint: React.ReactNode
  /** Committed value. */
  value: string
  /** Called with the raw string on every keystroke. */
  onChange: (next: string) => void
  /** Placeholder shown when the field is blank. */
  placeholder?: string
  /** Disable the input. */
  disabled?: boolean
}

/** A label + wide text input + hint row. */
export default function TextField ({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  disabled
}: Props): React.ReactElement {
  return (
    <LabeledField id={id} label={label} hint={hint}>
      {(controlProps) => (
        <input
          {...controlProps}
          type='text'
          style={S.inputWide}
          placeholder={placeholder}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </LabeledField>
  )
}
