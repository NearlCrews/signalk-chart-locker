/**
 * Pure reducer over the plugin's ChartLockerConfig shape, driving the
 * configuration panel's working state. It carries no React dependency, so it
 * is exported and unit-tested directly.
 *
 * Every case returns a new object only on a real change, and returns the input
 * state otherwise, so the panel can use identity equality against the
 * last-saved snapshot as a sound dirty check.
 */

import type {
  AdvancedConfig,
  ChartLockerConfig,
  ChartsConfig,
  TileCacheConfig
} from './config-types.js'

/** Actions the panel dispatches to mutate its working configuration. */
export type ConfigAction =
  | { type: 'setCacheCapGiB', giB: number }
  | { type: 'setRegionsBudgetGiB', giB: number }
  | { type: 'setChartsPath', path: string }
  | { type: 'setImageTag', tag: string }
  | { type: 'setCacheVolumeSource', path: string }
  | { type: 'discard', config: ChartLockerConfig }

/**
 * Replace one field inside a group, returning the whole config unchanged when
 * the field is already equal. The group object is rebuilt only on a real
 * change, so both the group and the top-level identity stay stable on a no-op,
 * which is what makes the panel's identity-based dirty check sound.
 */
function setGroupField<
  G extends keyof ChartLockerConfig,
  K extends keyof ChartLockerConfig[G]
> (state: ChartLockerConfig, groupKey: G, fieldKey: K, value: ChartLockerConfig[G][K]): ChartLockerConfig {
  const currentGroup = state[groupKey]
  if (currentGroup[fieldKey] === value) return state
  return { ...state, [groupKey]: { ...currentGroup, [fieldKey]: value } }
}

/**
 * Apply an action to the configuration. Each case returns a new object only
 * when something actually changed and returns the input state otherwise.
 */
export function configReducer (state: ChartLockerConfig, action: ConfigAction): ChartLockerConfig {
  switch (action.type) {
    case 'discard':
      return action.config
    case 'setCacheCapGiB':
      return setGroupField<'tileCache', keyof TileCacheConfig>(state, 'tileCache', 'cacheCapGiB', action.giB)
    case 'setRegionsBudgetGiB':
      return setGroupField<'tileCache', keyof TileCacheConfig>(state, 'tileCache', 'regionsBudgetGiB', action.giB)
    case 'setChartsPath':
      return setGroupField<'charts', keyof ChartsConfig>(state, 'charts', 'path', action.path)
    case 'setImageTag':
      return setGroupField<'advanced', keyof AdvancedConfig>(state, 'advanced', 'imageTag', action.tag)
    case 'setCacheVolumeSource':
      return setGroupField<'advanced', keyof AdvancedConfig>(state, 'advanced', 'cacheVolumeSource', action.path)
  }
}
