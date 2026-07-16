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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupControl,
  LabeledField,
  NumberInput,
  RangeInput,
  type FieldControlProps
} from 'signalk-nearlcrews-ui'
import { useNumberDraft } from '../hooks/use-number-draft.js'

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
  return (
    <LabeledField label={label} description={hint} layout='inline'>
      <RangeControl
        id={id}
        label={label}
        min={min}
        max={max}
        step={step}
        unit={unit}
        disabled={disabled}
        value={value}
        onChange={onChange}
      />
    </LabeledField>
  )
}

interface RangeControlProps extends FieldControlProps {
  label: string
  value: number
  onChange: (next: number) => void
  min: number
  max: number
  step: number
  unit?: string
  disabled?: boolean
}

/** Composite control whose outer id lets LabeledField preserve the caller's stable slider id. */
function RangeControl ({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  disabled,
  required,
  'aria-describedby': ariaDescribedBy,
  'aria-errormessage': ariaErrorMessage,
  'aria-invalid': ariaInvalid
}: RangeControlProps): React.ReactElement {
  const draft = useNumberDraft(value, onChange, { min, max, integer: true, step })
  const numberId = `${id ?? 'range'}-number`

  return (
    <InputGroup density='compact'>
      <InputGroupControl width='grow'>
        <RangeInput
          id={id}
          aria-describedby={ariaDescribedBy}
          aria-errormessage={ariaErrorMessage}
          aria-invalid={ariaInvalid}
          required={required}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </InputGroupControl>
      <InputGroupControl width='fixed'>
        <NumberInput
          id={numberId}
          aria-label={`${label} exact value`}
          aria-describedby={ariaDescribedBy}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={draft.display}
          onChange={(event) => draft.handleChange(event.target.value)}
          onBlur={draft.handleBlur}
        />
        {unit !== undefined ? <InputGroupAddon>{unit}</InputGroupAddon> : null}
      </InputGroupControl>
    </InputGroup>
  )
}
