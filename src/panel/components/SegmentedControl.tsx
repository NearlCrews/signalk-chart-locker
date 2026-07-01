/**
 * Compact segmented control: a bordered fieldset of aria-pressed buttons
 * with the active segment filled by the accent. Used by the theme toggle;
 * generic over the choice value so a future view switcher can reuse it.
 * Each segment is a 36px touch target, sized for wet fingers at the helm.
 */

import type * as React from 'react'
import { S } from '../styles.js'

interface Props<V extends string> {
  /** Visually hidden `<legend>` naming the control for screen readers. */
  legend: string
  choices: ReadonlyArray<{ value: V, label: string }>
  value: V
  onChange: (next: V) => void
  disabled?: boolean
}

/** A segmented choice control rendered as a fieldset of toggle buttons. */
export default function SegmentedControl<V extends string> ({
  legend,
  choices,
  value,
  onChange,
  disabled
}: Props<V>): React.ReactElement {
  return (
    <fieldset style={S.segmented}>
      <legend style={S.visuallyHidden}>{legend}</legend>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type='button'
          aria-pressed={value === choice.value}
          style={value === choice.value ? S.segmentedBtnActive : S.segmentedBtn}
          onClick={() => onChange(choice.value)}
          disabled={disabled}
        >
          {choice.label}
        </button>
      ))}
    </fieldset>
  )
}
