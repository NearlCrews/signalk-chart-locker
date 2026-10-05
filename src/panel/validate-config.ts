import { formatCount } from 'signalk-nearlcrews-ui/format'
import type { ChartLockerConfig } from './config-types.js'
import { configPathIssue, MAX_CONFIG_PATH_LENGTH } from '../shared/config-path.js'
import { isValidImageTag } from '../shared/image-tag.js'

export interface PanelValidation {
  regionsBudget: string | null
  chartsPath: string | null
  cacheVolumeSource: string | null
  imageTag: string | null
}

function pathTextError (label: string, value: string): string | null {
  const issue = configPathIssue(value)
  if (issue === 'too-long') return `Shorten the ${label} to ${formatCount(MAX_CONFIG_PATH_LENGTH, 'character')} or fewer.`
  if (issue === 'control-character') return `Remove the control characters from the ${label}.`
  return null
}

/**
 * Validate the panel's normalized working configuration before it reaches the runtime boundary.
 * Each message says how to fix the field, because it is read beside the control that has to change.
 */
export function validatePanelConfig (state: ChartLockerConfig): PanelValidation {
  const chartsPathTextError = pathTextError('PMTiles charts directory', state.charts.path)
  const cacheVolumeTextError = pathTextError('external tile cache drive path', state.advanced.cacheVolumeSource)

  return {
    regionsBudget: state.tileCache.regionsBudgetGiB > state.tileCache.cacheCapGiB
      ? 'Set the saved-regions reserved budget no higher than the cache cap.'
      : null,
    chartsPath: chartsPathTextError ?? (
      state.charts.path.startsWith('/') || state.charts.path.split(/[\\/]+/).includes('..')
        ? 'Use a path relative to the Signal K configuration directory, with no leading / and no .. segments.'
        : null
    ),
    cacheVolumeSource: cacheVolumeTextError ?? (
      state.advanced.cacheVolumeSource !== '' && !state.advanced.cacheVolumeSource.startsWith('/')
        ? 'Use an absolute host path that starts with /, such as /mnt/ssd/tilecache.'
        : null
    ),
    imageTag: state.advanced.imageTag !== '' && !isValidImageTag(state.advanced.imageTag)
      ? 'Use only letters, digits, underscores, periods, and hyphens, starting with a letter, digit, or underscore.'
      : null
  }
}
