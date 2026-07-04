/**
 * A non-fatal message banner. Two variants: 'danger' for an error (assertive,
 * red tokens) and 'warn' for an advisory (polite, amber tokens). Centralizing
 * the variant-to-role and variant-to-style pairing here keeps the two banner
 * sites from drifting, and keeps an advisory from announcing as assertively as
 * an error.
 */

import type * as React from 'react'
import { S } from '../styles.js'

interface Props {
  variant: 'danger' | 'warn'
  children: React.ReactNode
}

export default function Banner ({ variant, children }: Props): React.ReactElement {
  const isDanger = variant === 'danger'
  return (
    <div role={isDanger ? 'alert' : 'status'} style={isDanger ? S.errorBanner : S.warnBanner}>
      {children}
    </div>
  )
}
