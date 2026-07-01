/**
 * Theme pinning control: a segmented Auto / Light / Dark / Night choice. A
 * controlled component: the panel root owns the choice (via the `useTheme`
 * hook) and renders it declaratively as the `data-cl-theme` attribute, so
 * this control is pure presentation.
 */

import type * as React from 'react'
import SegmentedControl from './SegmentedControl.js'
import type { ThemeChoice } from '../hooks/use-theme.js'

const CHOICES: ReadonlyArray<{ value: ThemeChoice, label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'night', label: 'Night' }
]

interface Props {
  value: ThemeChoice
  onChange: (next: ThemeChoice) => void
}

/** The panel-theme segmented control mounted in the top control bar. */
export default function ThemeToggle ({ value, onChange }: Props): React.ReactElement {
  return (
    <SegmentedControl
      legend='Panel theme'
      choices={CHOICES}
      value={value}
      onChange={onChange}
    />
  )
}
