/**
 * A collapsible "Advanced" disclosure, built on the native `<details>`/`<summary>`
 * element, styled to read as one more section card. The browser gives keyboard
 * toggling, focus, and the open/closed marker for free, and a closed `<details>`
 * keeps its children in the DOM (just hidden), so an in-progress field draft
 * survives a collapse-and-expand round trip. Collapsed by default, so the
 * rarely-changed settings stay tucked away until a user opens them.
 */

import type * as React from 'react'
import { S } from '../styles.js'

interface Props {
  /** The always-visible summary label. Defaults to "Advanced", the only label in use. */
  summary?: string
  /** The controls revealed when the disclosure is open. */
  children: React.ReactNode
}

/** A native, accessible collapsible section for advanced or rarely-used controls. */
export default function Disclosure ({ summary = 'Advanced', children }: Props): React.ReactElement {
  return (
    <details style={S.disclosure}>
      <summary style={S.disclosureSummary}>{summary}</summary>
      <div style={S.disclosureBody}>{children}</div>
    </details>
  )
}
