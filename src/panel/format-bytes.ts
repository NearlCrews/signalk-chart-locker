/**
 * Byte formatting for the panel's live cache readouts. Kept React-free and
 * separate from the components so the metric grid and the per-source grid
 * share one implementation and the rounding rules stay unit-testable.
 *
 * Binary units throughout: the cache cap, the saved-regions budget, and the
 * container's own accounting are all in GiB, so a decimal readout beside them
 * would misreport the same number.
 */

// The operator's locale decides the grouping separator and the decimal mark, the same way the
// per-source tile counts beside these figures already do. A hand-rolled toFixed would print a
// period next to a comma-decimal tile count in the same table row.
const WHOLE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const ONE_DECIMAL = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
})

/**
 * Split a byte count into a rounded value and its unit, for the Metric unit
 * suffix slot. A null count reports as "Unknown" with no unit.
 */
export function splitBytes (bytes: number | null): { value: string, unit?: string } {
  if (bytes === null) return { value: 'Unknown' }
  if (bytes < 1024 ** 2) return { value: WHOLE.format(bytes / 1024), unit: 'KiB' }
  if (bytes < 1024 ** 3) return { value: ONE_DECIMAL.format(bytes / 1024 ** 2), unit: 'MiB' }
  return { value: ONE_DECIMAL.format(bytes / 1024 ** 3), unit: 'GiB' }
}

/** Render a byte count as one string, for a cell or a sentence. */
export function formatBytes (bytes: number | null): string {
  const { value, unit } = splitBytes(bytes)
  return unit === undefined ? value : `${value} ${unit}`
}
