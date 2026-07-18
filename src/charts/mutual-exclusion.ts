/** Detect whether the third-party signalk-pmtiles-plugin is enabled. Running both would show
 * duplicate charts: the resources read path merges all providers and the two id schemes do not
 * dedupe. The plugin enabled state lives in <configPath>/plugin-config-data/<pluginId>.json. */

import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { readJsonState } from '../runtime/json-state.js'

const THIRD_PARTY_PLUGIN_ID = 'pmtiles-chart-provider'

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isThirdPartyPmtilesEnabled (configPath: string): boolean {
  const file = join(configPath, 'plugin-config-data', `${THIRD_PARTY_PLUGIN_ID}.json`)
  const parsed = readJsonState<Record<string, unknown>>(file, {}, {
    validate: isRecord,
    // The Signal K server owns this file. Never rename another plugin's configuration.
    backupCorrupt: false
  })
  return parsed.enabled === true
}

export interface MutualExclusionWatcher {
  stop: () => Promise<void>
}

/** Watch the server-owned plugin config, with a slow poll to self-heal dropped directory events. */
export function watchThirdPartyPmtilesEnabled (
  configPath: string,
  onChange: (enabled: boolean) => unknown,
  options: { intervalMs?: number, retryBaseMs?: number, onError?: (error: unknown) => void } = {}
): MutualExclusionWatcher {
  const directory = join(configPath, 'plugin-config-data')
  const fileName = `${THIRD_PARTY_PLUGIN_ID}.json`
  let applied = isThirdPartyPmtilesEnabled(configPath)
  let observed = applied
  let stopped = false
  let watcher: FSWatcher | undefined
  let applyTimer: NodeJS.Timeout | undefined
  let transition: Promise<void> | null = null
  let retryMs = Math.max(1, options.retryBaseMs ?? 100)
  const retryBaseMs = retryMs

  const scheduleApply = (delayMs = 0): void => {
    if (stopped || transition !== null || observed === applied || applyTimer !== undefined) return
    applyTimer = setTimeout(() => {
      applyTimer = undefined
      if (stopped || transition !== null || observed === applied) return
      const target = observed
      let succeeded = false
      transition = Promise.resolve()
        .then(() => onChange(target))
        .then(() => {
          succeeded = true
          if (!stopped) applied = target
          retryMs = retryBaseMs
        })
        .catch((error: unknown) => {
          options.onError?.(error)
        })
        .finally(() => {
          transition = null
          if (stopped || observed === applied) return
          if (succeeded) scheduleApply()
          else {
            scheduleApply(retryMs)
            retryMs = Math.min(retryMs * 2, 5000)
          }
        })
    }, delayMs)
    applyTimer.unref()
  }

  const check = (): void => {
    if (stopped) return
    try {
      const current = isThirdPartyPmtilesEnabled(configPath)
      if (current !== observed) {
        observed = current
        scheduleApply()
      }
    } catch (error) {
      options.onError?.(error)
    }
  }

  const installWatcher = (): void => {
    // libuv's Windows fs-event watcher can abort the process when a watched temporary directory is
    // removed during shutdown. Discovery and region state already use polling off Linux for the
    // same portability reason. Keep native events on the deployment platform and use the existing
    // self-heal poll everywhere else.
    if (process.platform !== 'linux' || stopped || watcher !== undefined) return
    try {
      watcher = watch(directory, (_event, changed) => {
        if (changed === null || changed.toString() === fileName) check()
      })
      watcher.unref()
      watcher.on('error', (error) => {
        options.onError?.(error)
        watcher?.close()
        watcher = undefined
      })
    } catch {
      // The plugin-config-data directory may not exist yet. The self-heal poll retries installation.
    }
  }

  installWatcher()
  const pollTimer = setInterval(() => {
    installWatcher()
    check()
  }, options.intervalMs ?? 5000)
  pollTimer.unref()
  return {
    async stop () {
      if (stopped) return
      stopped = true
      clearInterval(pollTimer)
      if (applyTimer !== undefined) clearTimeout(applyTimer)
      watcher?.close()
      watcher = undefined
      if (transition !== null) await transition
    }
  }
}
