const LEGACY_RELEASE_DEFAULT_TAGS: ReadonlySet<string> = new Set([
  'v0.1.0',
  'v0.1.1',
  'v0.2.0',
  'v0.3.0',
  'v0.3.1',
  'v0.4.0',
  'v0.4.1',
  'v0.4.2',
  'v0.4.3',
  'v0.4.4',
  'v0.5.0'
])

/**
 * Convert a release-pinned tag that an older schema stored as its default back to the empty
 * override. The runtime then follows the current plugin version, while any other explicit
 * development or custom tag remains intact.
 */
export function migrateLegacyTilecacheTag (rawTag: string | undefined): string | undefined {
  if (rawTag === undefined) return undefined
  const tag = rawTag.trim()
  return LEGACY_RELEASE_DEFAULT_TAGS.has(tag) ? '' : tag
}
