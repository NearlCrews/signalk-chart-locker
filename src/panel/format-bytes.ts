/**
 * Byte formatting for the panel's live cache readouts. Kept React-free and
 * separate from the components so the metric grid and the per-source table
 * share one implementation and the rounding rules stay unit-testable.
 *
 * Binary units throughout: the cache cap, the saved-regions budget, and the
 * container's own accounting are all in GiB, so a decimal readout beside them
 * would misreport the same number.
 */

import type { NamedUnit } from 'signalk-nearlcrews-ui'

/**
 * The binary units the panel draws, each with the name a screen reader reads in place of a symbol
 * it would otherwise spell out letter by letter.
 */
export const BYTE_UNITS = {
  KiB: { symbol: 'KiB', name: 'kibibytes' },
  MiB: { symbol: 'MiB', name: 'mebibytes' },
  GiB: { symbol: 'GiB', name: 'gibibytes' }
} as const satisfies Record<string, NamedUnit>

// The operator's locale decides the grouping separator and the decimal mark, the same way the
// per-source tile counts beside these figures already do. A hand-rolled toFixed would print a
// period next to a comma-decimal tile count in the same table row.
/** Grouped whole numbers, for the KiB readout. Exported so its unit test measures this formatter. */
export const WHOLE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
/** Grouped one-decimal numbers, for the MiB and GiB readouts and the free-space note beside the cap. */
export const ONE_DECIMAL = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
})

/**
 * Split a byte count into a rounded value and its unit, for a metric or a table cell to draw. A null
 * count reports as "Unknown" with no unit.
 */
export function splitBytes (bytes: number | null): { value: string, unit?: NamedUnit } {
  if (bytes === null) return { value: 'Unknown' }
  if (bytes < 1024 ** 2) return { value: WHOLE.format(bytes / 1024), unit: BYTE_UNITS.KiB }
  if (bytes < 1024 ** 3) return { value: ONE_DECIMAL.format(bytes / 1024 ** 2), unit: BYTE_UNITS.MiB }
  return { value: ONE_DECIMAL.format(bytes / 1024 ** 3), unit: BYTE_UNITS.GiB }
}
