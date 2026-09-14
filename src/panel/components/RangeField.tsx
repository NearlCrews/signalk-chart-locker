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
  LabeledField,
  NumberInput,
  RangeInput,
  splitLabeledFieldControlProps,
  useNumberDraft
} from 'signalk-nearlcrews-ui'

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
  /** Slider and stepper increment. Defaults to 1. */
  step?: number
  /** Unit suffix shown after the number box and read with both controls, for example "GiB". */
  unit?: string
  /** Disable both controls. */
  disabled?: boolean
}

/** Join the ids a control is described by, or undefined when there are none. */
function describedBy (...ids: Array<string | undefined>): string | undefined {
  const present = ids.filter((id): id is string => id !== undefined)
  return present.length === 0 ? undefined : present.join(' ')
}

/** A label + slider + number box + hint row for a bounded whole-number value. */
export default function RangeField ({
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
  // A fallback puts the draft in clamp mode: empty input commits the minimum, and every parsed value
  // snaps to the step and clamps to the bounds, which is what keeps the slider and the box agreeing.
  const draft = useNumberDraft(
    value,
    (next) => { if (next !== undefined) onChange(next) },
    { min, max, integer: true, step, fallback: min }
  )

  return (
    <LabeledField label={label} description={hint} layout='inline' disabled={disabled}>
      {(contract) => {
        const { controlProps } = splitLabeledFieldControlProps(contract)
        const unitId = unit === undefined ? undefined : `${controlProps.id}-unit`
        const description = describedBy(controlProps['aria-describedby'], unitId)
        return (
          <InputGroup density='compact'>
            <InputGroupControl controlWidth='grow'>
              <RangeInput
                {...controlProps}
                aria-describedby={description}
                // The unit addon describes the control, and a description is announced once on
                // focus. Dragging or arrowing the slider announces the value again on every step,
                // so the value carries its own unit rather than reading as a bare number.
                aria-valuetext={unit === undefined ? undefined : `${value} ${unit}`}
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
                aria-describedby={description}
                disabled={controlProps.disabled}
              />
              {unit !== undefined ? <InputGroupAddon id={unitId}>{unit}</InputGroupAddon> : null}
            </InputGroupControl>
          </InputGroup>
        )
      }}
    </LabeledField>
  )
}
