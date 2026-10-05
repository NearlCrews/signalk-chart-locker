/** Narrow an unknown value to a nonnegative integer that a double represents exactly. Shared by every
 * reader of an untrusted container count or byte total, so they cannot disagree on the bound. */
export function isNonnegativeSafeInteger (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
