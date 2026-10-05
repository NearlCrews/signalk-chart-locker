/**
 * React state hook for the panel's working configuration, built on the three states the Signal K
 * admin UI opens a panel in: `configuration` undefined for a plugin nobody has configured, `{}` for a
 * package enabled by default before its first save, and, after a save, the object the panel saved,
 * handed straight back without waiting for the server.
 *
 * It keeps one edit buffer, seeded from the normalized prop, and compares that buffer with the
 * configuration the host holds now rather than with a copy of it in state. After a save the echoed
 * object matches the buffer, so the panel reads clean with no resync code, while an edit in progress
 * stays in the buffer whatever the host passes.
 */

import type { Dispatch } from 'react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ChartLockerConfig } from '../config-types.js'
import { changedConfigGroups, type ConfigGroup } from '../config-changes.js'
import { configReducer, type ConfigAction } from '../config-reducer.js'
import { normalizeConfig } from '../normalize-config.js'

/** The configuration state surface the panel consumes. */
export interface UseConfigResult {
  /** The edit buffer, holding text exactly as the operator typed it. */
  draft: ChartLockerConfig
  /** The buffer as a save sends it, normalized the way the plugin reads its configuration. */
  pending: ChartLockerConfig
  /** The configuration the host holds now, normalized. */
  saved: ChartLockerConfig
  /**
   * The groups a save would change, as changedConfigGroups lists them. Empty while clean. The same
   * array survives an edit that leaves the list as it was, so a memo keyed on it holds.
   */
  changes: readonly ConfigGroup[]
  /** Whether nobody has configured the plugin yet, which makes Save the action that enables it. */
  unconfigured: boolean
  /** Dispatches a ConfigAction through the reducer. */
  dispatch: Dispatch<ConfigAction>
  /** Restores the buffer from what a save would replace. */
  discard: () => void
}

/** The defaults with the cache cap sized from free space, normalized like every other baseline. */
function withSeededCap (saved: ChartLockerConfig, giB: number): ChartLockerConfig {
  return normalizeConfig(configReducer(saved, { type: 'setCacheCapGiB', giB }))
}

/**
 * Manage the panel's configuration state.
 *
 * `recommendedCapGiB` is the cap the cache-info route sizes from the detected free space, or null
 * until it answers. For a plugin nobody has configured the panel adopts it once, as part of what Save
 * will enable rather than as an edit of the operator's, so the save bar keeps offering to enable the
 * plugin instead of reporting unsaved changes nobody made.
 */
export function useConfig (configuration: unknown, recommendedCapGiB: number | null): UseConfigResult {
  const unconfigured = configuration === undefined
  const saved = useMemo(() => normalizeConfig(configuration), [configuration])
  const [seededCapGiB, setSeededCapGiB] = useState<number | null>(null)
  // What a save would replace: what the host holds, or for an unconfigured plugin the defaults with
  // the seeded cap. The seed stops counting once the host holds a configuration, so a cap the
  // operator saved is compared with itself rather than with the seed it replaced.
  const baseline = useMemo(
    () => (unconfigured && seededCapGiB !== null ? withSeededCap(saved, seededCapGiB) : saved),
    [saved, seededCapGiB, unconfigured]
  )
  const [draft, dispatch] = useReducer(configReducer, baseline)
  const pending = useMemo(() => normalizeConfig(draft), [draft])
  // Every keystroke builds a new pending buffer, and almost none of them changes which groups
  // differ, so the previous list is handed back whenever it reads the same.
  const changesRef = useRef<readonly ConfigGroup[]>([])
  const changes = useMemo(() => {
    const next = changedConfigGroups(pending, baseline)
    const previous = changesRef.current
    if (next.length === previous.length && next.every((group, index) => group === previous[index])) return previous
    changesRef.current = next
    return next
  }, [pending, baseline])

  // Decided once, when the recommendation first arrives. An operator who edited anything before the
  // route answered keeps their edits, and a recommendation never lands later over a value they are
  // already looking at.
  const seedDecidedRef = useRef(false)
  const clean = changes.length === 0
  useEffect(() => {
    if (seedDecidedRef.current || recommendedCapGiB === null) return
    seedDecidedRef.current = true
    if (!unconfigured || !clean) return
    setSeededCapGiB(recommendedCapGiB)
    dispatch({ type: 'discard', config: withSeededCap(saved, recommendedCapGiB) })
  }, [clean, recommendedCapGiB, saved, unconfigured])

  const discard = useCallback((): void => {
    dispatch({ type: 'discard', config: baseline })
  }, [baseline])

  return { draft, pending, saved, changes, unconfigured, dispatch, discard }
}
