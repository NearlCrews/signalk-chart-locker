/**
 * A controlled whole-number field rendered as a slider paired with a compact
 * numeric readout and a unit suffix. Used by the cache size cap, whose bounds
 * (4 to 32 GiB) suit a slider while the number box keeps an exact value one
 * keystroke away.
 *
 * The slider and the number box drive the same committed value. The slider
 * always yields an in-range integer, so it commits directly; the number box
 * goes through `useNumberDraft` so it can be cleared mid-edit and is clamped
 * on commit to the same bounds.
 */

import type * as React from 'react'
import { useNumberDraft } from '../hooks/use-number-draft.js'
import LabeledField from './LabeledField.js'
import { S } from '../styles.js'

interface Props {
  /** Stable id linking the visible label to the slider. */
  id: string
  /** Visible field label. */
  label: string
  /** Hint paragraph rendered below the row. */
  hint: React.ReactNode
  /** Committed value. */
  value: number
  /** Called with the clamped whole-number value on every change. */
  onChange: (next: number) => void
  /** Smallest allowed value. */
  min: number
  /** Largest allowed value. */
  max: number
  /** Slider and stepper increment. Defaults to 1. */
  step?: number
  /** Unit suffix shown after the number box, for example "GiB". */
  unit?: string
  /** Disable both controls. */
  disabled?: boolean
}

/** A label + slider + number box + hint row for a bounded whole-number value. */
export default function RangeField ({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  disabled
}: Props): React.ReactElement {
  const draft = useNumberDraft(value, onChange, { min, max, integer: true, step })
  const numberId = `${id}-number`

  return (
    <LabeledField id={id} label={label} hint={hint}>
      {(controlProps) => (
        <div style={S.rangeRow}>
          <input
            id={controlProps.id}
            aria-describedby={controlProps['aria-describedby']}
            type='range'
            min={min}
            max={max}
            step={step}
            style={S.range}
            disabled={disabled}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <input
            id={numberId}
            aria-label={`${label} exact value`}
            aria-describedby={controlProps['aria-describedby']}
            type='number'
            min={min}
            max={max}
            step={step}
            style={S.rangeNumber}
            disabled={disabled}
            value={draft.display}
            onChange={(e) => draft.handleChange(e.target.value)}
            onBlur={draft.handleBlur}
          />
          {unit !== undefined ? <span style={S.rangeUnit}>{unit}</span> : null}
        </div>
      )}
    </LabeledField>
  )
}
