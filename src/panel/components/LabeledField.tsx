/**
 * The shared label + control + hint scaffold every labeled field on the panel
 * renders: a one-row label-control pair, then the hint as a sibling block
 * below, so a narrow control does not push the hint into a cramped wrap
 * beside the field.
 *
 * The control is supplied through a render prop that receives the `id` (for
 * the label's `htmlFor`) and an `aria-describedby` pointing at the hint
 * paragraph, so the hint text is programmatically linked to the control and a
 * screen-reader user hears the constraint text, not just the label. Building
 * the wiring into the scaffold makes the link impossible to forget in a new
 * field.
 */

import type * as React from 'react'
import { S } from '../styles.js'

/** The props the render prop must spread onto its control element. */
export interface LabeledControlProps {
  id: string
  'aria-describedby': string
}

interface Props {
  /** Stable id linking the visible label to the control. */
  id: string
  /** Visible field label. */
  label: string
  /** Hint paragraph rendered below the row, linked via aria-describedby. */
  hint: React.ReactNode
  /** Render the control, spreading the given props onto it. */
  children: (controlProps: LabeledControlProps) => React.ReactElement
}

/** A label + control + hint row; the control comes from the render prop. */
export default function LabeledField ({ id, label, hint, children }: Props): React.ReactElement {
  const hintId = `${id}-hint`
  return (
    <>
      <div style={S.fieldRow}>
        <label htmlFor={id} style={S.label}>{label}</label>
        {children({ id, 'aria-describedby': hintId })}
      </div>
      <p id={hintId} style={S.hintBelow}>{hint}</p>
    </>
  )
}
