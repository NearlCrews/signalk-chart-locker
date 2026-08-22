/**
 * Byte formatting for the panel's live cache readouts. Kept React-free and
 * separate from the components so the metric grid and the per-source grid
 * share one implementation and the rounding rules stay unit-testable.
 *
 * Binary units throughout: the cache cap, the saved-regions budget, and the
 * container's own accounting are all in GiB, so a decimal readout beside them
 * would misreport the same number.
 */

/**
 * Split a byte count into a rounded value and its unit, for the Metric unit
 * suffix slot. A null count reports as "Unknown" with no unit.
 */
export function splitBytes (bytes: number | null): { value: string, unit?: string } {
  if (bytes === null) return { value: 'Unknown' }
  if (bytes < 1024 ** 2) return { value: `${Math.round(bytes / 1024)}`, unit: 'KiB' }
  if (bytes < 1024 ** 3) return { value: (bytes / 1024 ** 2).toFixed(1), unit: 'MiB' }
  return { value: (bytes / 1024 ** 3).toFixed(1), unit: 'GiB' }
}

/** Render a byte count as one string, for a cell or a sentence. */
export function formatBytes (bytes: number | null): string {
  const { value, unit } = splitBytes(bytes)
  return unit === undefined ? value : `${value} ${unit}`
}
