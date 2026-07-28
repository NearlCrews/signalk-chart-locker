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
