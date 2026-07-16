/** True when a string contains a C0, DEL, C1, or Unicode line-separator control. */
export function hasControlCharacter (value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}

/** Trim and bound user-facing text, rejecting embedded control characters. */
export function normalizePrintableText (value: unknown, maxLength: number, allowEmpty = false): string | undefined {
  if (typeof value !== 'string' || hasControlCharacter(value)) return undefined
  const normalized = value.trim()
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maxLength) return undefined
  return normalized
}
