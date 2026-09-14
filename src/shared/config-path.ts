import { hasControlCharacter } from './text.js'

/** Bound configured filesystem paths before they reach resolution, filesystem APIs, or logs. */
export const MAX_CONFIG_PATH_LENGTH = 4096

export type ConfigPathIssue = 'too-long' | 'control-character' | null

/** Report the shared text-level validation issue for a configured filesystem path. */
export function configPathIssue (value: string): ConfigPathIssue {
  if (value.length > MAX_CONFIG_PATH_LENGTH) return 'too-long'
  if (hasControlCharacter(value)) return 'control-character'
  return null
}

/**
 * The charts directory the plugin falls back to when the configured path is blank, relative to the
 * Signal K configuration directory. The runtime resolves it, the panel places it in its hint, its
 * placeholder, and its empty-state orientation, and the schema description names it, so every one of
 * them reads the same default.
 */
export const DEFAULT_CHARTS_SUBPATH = 'charts/pmtiles'
