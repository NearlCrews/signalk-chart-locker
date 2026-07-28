import type { ChartLockerConfig } from './config-types.js'
import { configPathIssue, MAX_CONFIG_PATH_LENGTH } from '../shared/config-path.js'

export interface PanelValidation {
  regionsBudget: string | null
  chartsPath: string | null
  cacheVolumeSource: string | null
  imageTag: string | null
}

function pathTextError (label: string, value: string): string | null {
  const issue = configPathIssue(value)
  if (issue === 'too-long') return `${label} must be at most ${MAX_CONFIG_PATH_LENGTH} characters.`
  if (issue === 'control-character') return `${label} must not contain control characters.`
  return null
}

/** Validate the panel's normalized working configuration before it reaches the runtime boundary. */
export function validatePanelConfig (state: ChartLockerConfig): PanelValidation {
  const chartsPathTextError = pathTextError('The PMTiles charts directory', state.charts.path)
  const cacheVolumeTextError = pathTextError('The external cache drive', state.advanced.cacheVolumeSource)

  return {
    regionsBudget: state.tileCache.regionsBudgetGiB > state.tileCache.cacheCapGiB
      ? 'Saved-regions budget cannot exceed the cache cap.'
      : null,
    chartsPath: chartsPathTextError ?? (
      state.charts.path.startsWith('/') || state.charts.path.split(/[\\/]+/).includes('..')
        ? 'The PMTiles charts directory must stay relative to the Signal K configuration directory.'
        : null
    ),
    cacheVolumeSource: cacheVolumeTextError ?? (
      state.advanced.cacheVolumeSource !== '' && !state.advanced.cacheVolumeSource.startsWith('/')
        ? 'The external cache drive must be an absolute host path.'
        : null
    ),
    imageTag: state.advanced.imageTag !== '' && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(state.advanced.imageTag)
      ? 'The container image tag is not a valid OCI tag.'
      : null
  }
}
