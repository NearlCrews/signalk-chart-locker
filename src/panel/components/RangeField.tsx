/**
 * A controlled whole-number field rendered as a slider paired with a compact
 * numeric readout and a unit suffix. Used by the cache size cap, whose bounds
 * (4 to 32 GiB) suit a slider while the number box keeps an exact value one
 * keystroke away.
 *
 * The slider and the number box drive the same committed value. The slider
 * always yields an in-range integer, so it commits directly; the number box
 * goes through the shared `useNumberDraft` in clamp mode, so it can be
 * cleared mid-edit while every keystroke commits a value snapped to the step
 * and clamped to the same bounds.
 */

import type * as React from 'react'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupControl,
  joinIdReferences,
  LabeledField,
  type NamedUnit,
  NumberInput,
  RangeInput,
  splitLabeledFieldControlProps,
  useNumberDraft
} from 'signalk-nearlcrews-ui'
import UnitText from './UnitText.js'

interface Props {
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
  /** Slider and stepper increment. */
  step: number
  /** The unit drawn after the number box and read with both controls. */
  unit: NamedUnit
}

/** A label + slider + number box + hint row for a bounded whole-number value. */
export default function RangeField ({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  unit
}: Props): React.ReactElement {
  // A fallback puts the draft in clamp mode: empty input commits the minimum, and every parsed value
  // snaps to the step and clamps to the bounds, which is what keeps the slider and the box agreeing.
  const draft = useNumberDraft(
    value,
    (next) => { if (next !== undefined) onChange(next) },
    { min, max, integer: true, step, fallback: min }
  )

  return (
    <LabeledField label={label} description={hint} layout='inline'>
      {(contract) => {
        const { controlProps } = splitLabeledFieldControlProps(contract)
        const unitId = `${controlProps.id}-unit`
        return (
          <InputGroup density='compact'>
            <InputGroupControl controlWidth='grow'>
              {/* The slider reads its unit with the value on every step, so the addon that
                  describes the number box would only repeat it. */}
              <RangeInput
                {...controlProps}
                unit={unit}
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
              />
            </InputGroupControl>
            <InputGroupControl controlWidth='fixed'>
              <NumberInput
                {...draft.inputProps}
                id={`${controlProps.id}-number`}
                aria-label={`${label} exact value`}
                // The package's own id-list rule, which also drops a duplicate: an id the field
                // already wired and the caller handed back would otherwise be read twice.
                aria-describedby={joinIdReferences(controlProps['aria-describedby'], unitId)}
              />
              <InputGroupAddon id={unitId}><UnitText unit={unit} /></InputGroupAddon>
            </InputGroupControl>
          </InputGroup>
        )
      }}
    </LabeledField>
  )
}
