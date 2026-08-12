/**
 * React state hook for the panel's working configuration. It wraps the pure
 * configReducer in a useReducer, normalizes the raw `configuration` prop the
 * admin UI hands in, and tracks the last requested snapshot for the dirty check.
 */

import type { Dispatch } from 'react'
import { useCallback, useReducer, useRef, useState } from 'react'
import type { ChartLockerConfig } from '../config-types.js'
import { configReducer, type ConfigAction } from '../config-reducer.js'
import { normalizeConfig } from '../normalize-config.js'

/** The configuration state surface the panel consumes. */
export interface UseConfigResult {
  /** The current working configuration, including any unsaved edits. */
  state: ChartLockerConfig
  /** The configuration as of the last save request (or the initial load). */
  requestedState: ChartLockerConfig
  /** Dispatches a ConfigAction through the reducer. */
  dispatch: Dispatch<ConfigAction>
  /** Records the current state as requested, clearing the dirty flag. */
  markSaveRequested: () => void
  /**
   * Replace both the working state and requested snapshot with `config`, so the panel adopts a value
   * (for example a free-space-seeded default) without counting it as an unsaved edit. Both point at
   * the same object, so the identity dirty check reads clean.
   */
  reseed: (config: ChartLockerConfig) => void
}

/**
 * Manage the panel's configuration state. `configuration` is read once at
 * mount; later changes to the prop are ignored, because the panel itself is
 * the only writer and updates `requestedState` directly through markSaveRequested.
 */
export function useConfig (configuration: unknown): UseConfigResult {
  const [initial] = useState<ChartLockerConfig>(() => normalizeConfig(configuration))
  const [state, dispatch] = useReducer(configReducer, initial)
  const [requestedState, setRequestedState] = useState<ChartLockerConfig>(initial)

  // Keep markSaveRequested's identity stable across renders by reading the latest
  // state through a ref, assigned during render (the same pattern the panel
  // root uses for handleSave) so the ref can never lag a committed state.
  const stateRef = useRef(state)
  stateRef.current = state
  const markSaveRequested = useCallback((): void => {
    setRequestedState(stateRef.current)
  }, [])

  // Point the working state and requested snapshot at the same object, so state === requestedState holds
  // and the panel does not read as dirty after adopting the seeded config.
  const reseed = useCallback((config: ChartLockerConfig): void => {
    dispatch({ type: 'discard', config })
    setRequestedState(config)
  }, [])

  return { state, requestedState, dispatch, markSaveRequested, reseed }
}
