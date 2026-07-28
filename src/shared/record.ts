/** Narrow an unknown value to a non-array object with string keys. */
export function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
