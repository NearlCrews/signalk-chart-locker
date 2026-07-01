/**
 * Raw-text draft state for a controlled numeric input. A bare controlled
 * `<input type='number'>` snaps back to the committed value on every
 * keystroke, so the user cannot clear the field mid-edit; this hook keeps the
 * literal typed string around until the input loses focus, then drops it so
 * the input renders the committed numeric value again.
 *
 * The hook also defines the canonical empty-input and parse-failure behavior:
 * both fall back to the configured `fallback` (or the minimum). A finite
 * parsed value is clamped to `[min, max]` and, when `integer: true`, truncated
 * to a whole number.
 */

import { useEffect, useRef, useState } from 'react'
import { snapToStep } from '../../shared/cache-cap.js'

/** Options that shape how a draft string is parsed and clamped on commit. */
export interface NumberDraftOptions {
  /** Smallest allowed value. The fallback when the input is empty or unparsable. */
  min: number
  /** Largest allowed value. Omit to leave the high end unbounded. */
  max?: number
  /** Truncate any fractional part on commit. */
  integer?: boolean
  /** Snap the committed value to the nearest multiple of this step. Omit to leave it unsnapped. */
  step?: number
  /** Value to commit for empty or unparsable input. Defaults to `min`. */
  fallback?: number
}

/** The state surface the controlled input consumes. */
interface NumberDraft {
  /** The text the input should render: the live draft if any, otherwise the committed value. */
  display: string
  /** Track a keystroke and commit a clamped numeric value through `onChange`. */
  handleChange: (raw: string) => void
  /** Drop the live draft, so the input snaps back to the committed value. */
  handleBlur: () => void
}

/**
 * Compute the numeric value a raw draft string should commit to, applying the
 * empty/fallback rule, the parse-failure fallback, the integer-truncation
 * option, and the min/max clamp. Extracted from {@link useNumberDraft} as a
 * pure function so the parsing and clamping rules can be unit-tested under
 * node:test without React testing infrastructure.
 */
export function commitNumberDraft (raw: string, options: NumberDraftOptions): number {
  const fallback = options.fallback ?? options.min
  if (raw.trim() === '') {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  let next = parsed
  if (options.integer === true) next = Math.trunc(next)
  // Snap before the final clamp so a snapped value cannot escape the bounds (for example a max that
  // is not itself a multiple of the step).
  if (options.step !== undefined && options.step > 0) next = snapToStep(next, options.step)
  if (options.max !== undefined && next > options.max) next = options.max
  if (next < options.min) next = options.min
  return next
}

/**
 * Drive a controlled numeric input with a draft-while-editing buffer. `value`
 * is the committed number; `onChange` receives the clamped value for every
 * keystroke (so the parent's state stays in sync as the user types).
 */
export function useNumberDraft (
  value: number,
  onChange: (next: number) => void,
  options: NumberDraftOptions
): NumberDraft {
  const [draft, setDraft] = useState<string | null>(null)

  // Drop the draft when the committed value changes externally (e.g. a
  // Discard action restores the saved snapshot, or the slider moves the same
  // value the number box edits). Without this, the input would keep rendering
  // the user's stale typed text. lastCommittedFromHere tracks the value the
  // hook itself last produced, so a self-driven update (handleChange calling
  // onChange) is recognized as ours and leaves the draft alone; any other
  // transition is treated as external and clears the draft.
  const lastCommittedFromHere = useRef<number | null>(null)
  useEffect(() => {
    if (lastCommittedFromHere.current === value) {
      lastCommittedFromHere.current = null
      return
    }
    setDraft(null)
  }, [value])

  return {
    display: draft ?? String(value),
    handleChange: (raw) => {
      setDraft(raw)
      const next = commitNumberDraft(raw, options)
      // Tag this committed value so the external-change detector recognizes
      // the next render's `value` as ours and leaves the draft in place.
      lastCommittedFromHere.current = next
      onChange(next)
    },
    handleBlur: () => setDraft(null)
  }
}
