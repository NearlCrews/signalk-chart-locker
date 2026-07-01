/** Detect whether the third-party signalk-pmtiles-plugin is enabled. Running both would show
 * duplicate charts: the resources read path merges all providers and the two id schemes do not
 * dedupe. The plugin enabled state lives in <configPath>/plugin-config-data/<pluginId>.json. */

import { join } from 'node:path'
import { readJsonState } from '../runtime/json-state.js'

const THIRD_PARTY_PLUGIN_ID = 'pmtiles-chart-provider'

export function isThirdPartyPmtilesEnabled (configPath: string): boolean {
  const file = join(configPath, 'plugin-config-data', `${THIRD_PARTY_PLUGIN_ID}.json`)
  const parsed = readJsonState<{ enabled?: unknown }>(file, {})
  return parsed.enabled === true
}
