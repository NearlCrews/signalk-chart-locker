/**
 * A titled section card: a header row with the section title and an optional
 * description, over a body of fields. Renders the title as an `<h2>` so screen
 * readers expose it as a real heading landmark, with the browser's default
 * heading margin and scale overridden so it reads as a card header, not a
 * large typographic header. The panel composes one Section per schema group
 * so the panel and the plain schema form present the same structure.
 */

import type * as React from 'react'
import { S } from '../styles.js'

interface Props {
  /** The section title, exposed as an h2 heading. */
  title: string
  /** An optional one-line description under the title. */
  description?: React.ReactNode
  /** The fields rendered in the section body. */
  children: React.ReactNode
}

/** A bordered, titled card wrapping a group of related fields. */
export default function Section ({ title, description, children }: Props): React.ReactElement {
  return (
    <section style={S.section}>
      <div style={S.sectionHeader}>
        <h2 style={S.sectionTitle}>{title}</h2>
        {description !== undefined ? <p style={S.sectionDescription}>{description}</p> : null}
      </div>
      <div style={S.sectionBody}>{children}</div>
    </section>
  )
}
