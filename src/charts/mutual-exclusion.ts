/** Detect whether the third-party signalk-pmtiles-plugin is enabled. Running both would show
 * duplicate charts: the resources read path merges all providers and the two id schemes do not
 * dedupe. The plugin enabled state lives in <configPath>/plugin-config-data/<pluginId>.json. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const THIRD_PARTY_PLUGIN_ID = 'pmtiles-chart-provider'

export function isThirdPartyPmtilesEnabled (configPath: string): boolean {
  const file = join(configPath, 'plugin-config-data', `${THIRD_PARTY_PLUGIN_ID}.json`)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown }
    return parsed.enabled === true
  } catch {
    return false
  }
}
