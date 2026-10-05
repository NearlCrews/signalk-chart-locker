/**
 * Which configuration groups a working copy changes against another, compared by value. Kept
 * React-free so it can be unit-tested directly.
 *
 * Value rather than identity, because an edit and its reverse rebuild a group that holds what it
 * held before, and that is not an unsaved change.
 */

import type { ChartLockerConfig } from './config-types.js'

/** The groups the panel edits, in the order the restart notice names them. */
const CONFIG_GROUPS = ['tileCache', 'charts', 'advanced'] as const

/** One group the panel edits. */
export type ConfigGroup = typeof CONFIG_GROUPS[number]

/**
 * Whether two groups hold the same values. A key a newer plugin version stored rides through the
 * normalizer and the reducer by reference, so it compares equal without the panel knowing it.
 */
function sameGroup (left: object, right: object): boolean {
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

/** The groups `next` changes against `current`, in CONFIG_GROUPS order. */
export function changedConfigGroups (next: ChartLockerConfig, current: ChartLockerConfig): ConfigGroup[] {
  return CONFIG_GROUPS.filter((group) => !sameGroup(next[group], current[group]))
}
