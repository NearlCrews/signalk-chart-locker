/** Detect whether the third-party signalk-pmtiles-plugin is enabled. Running both would show
 * duplicate charts: the resources read path merges all providers and the two id schemes do not
 * dedupe. The plugin enabled state lives in <configPath>/plugin-config-data/<pluginId>.json. */

import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { readJsonState } from '../runtime/json-state.js'
import { isRecord } from '../shared/record.js'

const THIRD_PARTY_PLUGIN_ID = 'pmtiles-chart-provider'
/** The npm package an operator installs and recognizes the third-party provider by. Every message that
 * names the conflict uses it, so the status line, the HTTP bodies, and the README agree. */
export const THIRD_PARTY_PMTILES_PACKAGE = 'signalk-pmtiles-plugin'

/**
 * What Chart Locker's own PMTiles provider is doing. 'serving' publishes and serves the discovered
 * charts. 'conflict' means the third-party provider is enabled and owns the charts. 'unavailable'
 * means neither: chart discovery has not answered yet for this start, or the plugin is stopped. The
 * routes outlive a stop and the status line opens before discovery answers, so only 'conflict' may
 * tell an operator to disable a plugin they may never have installed.
 */
export type PmtilesProviderState = 'serving' | 'conflict' | 'unavailable'

/** How a PMTiles route refuses a request while the provider is not serving. */
export interface PmtilesRefusal {
  status: 409 | 503
  message: string
}

/**
 * The refusal for a PMTiles route, or null while the provider is serving. `activity` names what the
 * route does, so the archive route and the management routes each say what the conflict disabled.
 */
export function pmtilesRefusal (state: PmtilesProviderState, activity: 'serving' | 'management'): PmtilesRefusal | null {
  if (state === 'serving') return null
  return state === 'conflict'
    ? { status: 409, message: `PMTiles ${activity} is disabled while ${THIRD_PARTY_PMTILES_PACKAGE} is enabled` }
    : { status: 503, message: 'PMTiles charts are unavailable while Chart Locker is stopped or starting' }
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

interface WatchOptions {
  intervalMs?: number
  retryBaseMs?: number
  onError?: (error: unknown) => void
  /**
   * The enabled state the caller's chart provider already reflects. A caller that set its provider up
   * some time before starting the watcher passes it, so a change made in between is applied on the
   * first pass instead of being adopted as already applied. Defaults to the state read at start.
   */
  applied?: boolean
}

/** Watch the server-owned plugin config, with a slow poll to self-heal dropped directory events. */
export function watchThirdPartyPmtilesEnabled (
  configPath: string,
  onChange: (enabled: boolean) => unknown,
  options: WatchOptions = {}
): MutualExclusionWatcher {
  const directory = join(configPath, 'plugin-config-data')
  const fileName = `${THIRD_PARTY_PLUGIN_ID}.json`
  let observed = isThirdPartyPmtilesEnabled(configPath)
  let applied = options.applied ?? observed
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
  scheduleApply()
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
