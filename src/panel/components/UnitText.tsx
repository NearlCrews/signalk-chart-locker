/**
 * A unit drawn as its symbol and read as its name, the way the shared UI reads a named unit inside
 * its own components. For the places none of them draws the unit: a table cell, the free-space
 * note, and the addon beside the cache cap's number box.
 */

import type * as React from 'react'
import { type NamedUnit, Text, type TextSize, type TextTone, VisuallyHidden } from 'signalk-nearlcrews-ui'

interface Props {
  unit: NamedUnit
}

/** A blank name leaves the symbol to be read as it is, the way the shared UI treats one. */
export default function UnitText ({ unit }: Props): React.ReactElement {
  const name = unit.name.trim()
  if (name === '') return <>{unit.symbol}</>
  return (
    <>
      <span aria-hidden='true'>{unit.symbol}</span>
      <VisuallyHidden>{name}</VisuallyHidden>
    </>
  )
}

interface ValueProps {
  value: string
  /** Absent for a figure that measures nothing, such as "Unknown", which is drawn alone. */
  unit?: NamedUnit | undefined
  size?: TextSize
  tone?: TextTone
}

/**
 * A figure and its unit as one unbroken run: a no-break space joins them and the run never wraps,
 * so a narrow table column widens and scrolls rather than splitting the unit from its value or the
 * unit itself, while prose around the run still wraps. Text sets its own color and size rather than
 * inheriting them, so a run inside styled text restates that text's tone and size.
 */
export function UnitValue ({ value, unit, ...text }: ValueProps): React.ReactElement {
  return (
    <Text wrap='nowrap' {...text}>
      {value}{unit === undefined ? null : <>{' '}<UnitText unit={unit} /></>}
    </Text>
  )
}
