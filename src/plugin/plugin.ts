/** The plugin factory: lifecycle that launches the tilecache container and registers chart providers. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_MOUNT_PATH } from '../shared/plugin-id.js'
import { requireContainerManager, getContainerManager, ensureRuntimeReady } from '../runtime/container-manager.js'
import { TILECACHE_CONTAINER_NAME, TILECACHE_INTERNAL_PORT, DEFAULT_CACHE_CAP_GIB, PLUGIN_VERSION, buildTilecacheConfig, probeTilecacheHealth, probeTilecacheHealthStatus, registerTilecacheUpdates, unregisterTilecacheUpdates } from '../runtime/tilecache-container.js'
import { buildSourcePayload, pushTilecacheConfig } from '../runtime/tilecache-config-push.js'
import { registerTileRoutes, type TileRouter } from '../http/tile-routes.js'
import { registerRegionsRoutes, type RegionsRouter, type RegionsRoutesHandle } from '../http/regions-routes.js'
import { registerCacheInfoRoute, type CacheInfoRouter } from '../http/cache-info-route.js'
import { ChartRegistry, registerChartProvider, type ChartRouteApp } from '../charts/chart-registry.js'
import { type DiscoveryHandle, startDiscovery } from '../charts/discovery.js'
import { isThirdPartyPmtilesEnabled, watchThirdPartyPmtilesEnabled, type MutualExclusionWatcher } from '../charts/mutual-exclusion.js'
import { registerPmtilesServeRoute, type ServeRouter } from '../http/pmtiles-routes.js'
import { registerChartManagementRoutes, type ManagementRouter } from '../http/chart-management-routes.js'
import { OverrideStore } from '../charts/overrides.js'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readFreeGiB } from '../runtime/free-space.js'
import { CACHE_CAP_MAX_GIB, CACHE_CAP_MIN_GIB, deriveDefaultCapGiB } from '../shared/cache-cap.js'
import { createPositionWarmer, type PositionWarmer } from '../runtime/position-warmer.js'
import { loadRegionsStore, mutateRegionsStore, reconcilePositionWarmSources, createCachedRegionsLoader, POSITION_WARM_REGION_ID, positionWarmBudgetBytes } from '../runtime/regions-store.js'
import { getRegionByteTotals, warmRegion } from '../runtime/tilecache-client.js'
import { isValidPosition } from '../runtime/position-warm.js'
import { getOrCreateControlToken } from '../runtime/control-token.js'
import { hasControlCharacter } from '../shared/text.js'
import { migrateLegacyTilecacheTag } from '../shared/tilecache-tag.js'
import { createHostHealthMonitor, type HostHealthMonitor, type HostHealthState } from '../runtime/host-health-monitor.js'

interface ChartLockerConfig {
  // Sectioned to match how the admin form groups the fields: nested objects render as titled
  // sections in the Signal K admin UI (rjsf), and the saved config mirrors that shape.
  tileCache?: {
    cacheCapGiB?: number
    regionsBudgetGiB?: number
  }
  charts?: {
    path?: string
  }
  advanced?: {
    imageTag?: string
    cacheVolumeSource?: string
    geocodingEnabled?: boolean
  }
}

interface AccessAwarePluginRouter {
  access?: (level: 'readonly') => unknown
}

interface PluginDeps {
  startDiscovery?: typeof startDiscovery
  registerRegionsRoutes?: typeof registerRegionsRoutes
  mutualExclusionPollIntervalMs?: number
  /** Test seam and defensive upper bound for container-manager calls that have no signal parameter. */
  managerOperationTimeoutMs?: number
  hostHealthMonitorIntervalMs?: number
  hostHealthFailureThreshold?: number
  hostHealthRecoveryCooldownMs?: number
}

const MANAGER_OPERATION_TIMEOUT_MS = 30_000
/** Bound admin-provided filesystem paths before they reach path resolution, filesystem APIs, logs,
 * or the container manager. This accommodates ordinary platform path limits without accepting an
 * effectively unbounded configuration string. */
const MAX_CONFIG_PATH_LENGTH = 4096

function readConfigPath (field: 'charts.path' | 'cacheVolumeSource', value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  if (value.length > MAX_CONFIG_PATH_LENGTH) throw new Error(`${field} must be at most ${MAX_CONFIG_PATH_LENGTH} characters`)
  if (hasControlCharacter(value)) throw new Error(`${field} must not contain control characters`)
  return value.trim()
}

type ManagerOperationOutcome<T> =
  | { status: 'completed', value: T }
  | { status: 'rejected', error: unknown }
  | { status: 'timeout' }
  | { status: 'aborted' }

/** Bound an otherwise uninterruptible manager promise while retaining its eventual completion. */
async function waitForManagerOperation<T> (
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ManagerOperationOutcome<T>> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (outcome: ManagerOperationOutcome<T>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => { finish({ status: 'aborted' }) }
    const timer = setTimeout(() => { finish({ status: 'timeout' }) }, timeoutMs)
    if (signal?.aborted === true) {
      finish({ status: 'aborted' })
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => { finish({ status: 'completed', value }) },
      (error: unknown) => { finish({ status: 'rejected', error }) }
    )
  })
}

export function createPlugin (app: ServerAPI, deps: PluginDeps = {}): Plugin {
  // All lifecycle transitions are serialized through this chain. It always resolves: errors from
  // doStart are caught in start(), and doStop never throws. This eliminates the concurrent-call
  // race where stop() setting a flag could be undone by a subsequent start() resetting it.
  let lifecycle: Promise<void> = Promise.resolve()
  let startController: AbortController | null = null
  // The tilecache container is non-fatal: the PMTiles chart provider and the plugin serve routes
  // work even if the tilecache container fails to start; only the tile cache and proxy are disabled.
  // Its address is held for the proxy routes.
  let tilecacheLaunched = false
  let tilecacheManager: ReturnType<typeof getContainerManager> = null
  let tilecacheAddress: string | null = null
  let configuredCachePath: string | null = null
  let tilecacheHealthy = false
  let tilecacheConfigured = false
  let tilecacheHealthDetail: string | null = null
  let hostHealthMonitor: HostHealthMonitor | null = null
  let controlToken: string | null = null
  let geocodingEnabled = true
  // Position-warm lifecycle state (factory scope, like tilecacheAddress).
  let positionUnsub: (() => void) | null = null
  let warmer: PositionWarmer | null = null
  // Closes the cached regions loader's filesystem watcher at teardown.
  let regionsLoaderStop: (() => void) | null = null
  let regionsRoutesHandle: RegionsRoutesHandle | null = null
  let pluginRunning = false
  // A manager mutation that outlived its caller's timeout remains tracked until it actually settles.
  // New launches are suppressed while it is pending, preventing a late cleanup stop from killing a
  // newer container with the same fixed name.
  let pendingManagerTransition: Promise<void> | null = null
  const configuredManagerTimeout = deps.managerOperationTimeoutMs
  const managerOperationTimeoutMs = typeof configuredManagerTimeout === 'number' && Number.isFinite(configuredManagerTimeout) && configuredManagerTimeout > 0
    ? configuredManagerTimeout
    : MANAGER_OPERATION_TIMEOUT_MS

  function trackManagerTransition (operation: Promise<unknown>, failureMessage: string): void {
    const tracked = operation
      .then(() => {}, (error: unknown) => { app.debug(failureMessage, error) })
      .finally(() => {
        if (pendingManagerTransition === tracked) pendingManagerTransition = null
      })
    pendingManagerTransition = tracked
  }

  function scheduleLateEnsureCleanup (operation: Promise<void>, manager: NonNullable<ReturnType<typeof getContainerManager>>): void {
    const cleanup = (async () => {
      try {
        await operation
      } catch (error) {
        app.debug('Timed-out tilecache launch eventually failed:', error)
        return
      }
      app.debug('Timed-out tilecache launch eventually completed; stopping the unclaimed container.')
      let stopOperation: Promise<void>
      try {
        stopOperation = manager.stop(TILECACHE_CONTAINER_NAME)
      } catch (error) {
        app.debug('Cannot stop the late tilecache launch:', error)
        return
      }
      const outcome = await waitForManagerOperation(stopOperation, managerOperationTimeoutMs)
      if (outcome.status === 'timeout') app.debug('Stopping the late tilecache launch exceeded the manager operation timeout.')
      else if (outcome.status === 'rejected') app.debug('Cannot stop the late tilecache launch:', outcome.error)
      // Keep this transition pending until the real manager mutation settles. A later start must not
      // launch the same container while this stop could still complete and remove it.
      try { await stopOperation } catch {}
    })()
    trackManagerTransition(cleanup, 'Late tilecache launch cleanup failed:')
  }

  interface ConfigAwareApp { config: { configPath: string } }
  const configPath = (app as unknown as ConfigAwareApp).config.configPath
  const registry = new ChartRegistry()
  // getDataDirPath is bound by the Signal K server onto the per-plugin app copy AFTER the plugin
  // factory runs (interfaces/plugins.js constructs the plugin, then assigns getDataDirPath), so it must
  // not be called here at construction time. Build the override store lazily on first use, which happens
  // in doStart or registerWithRouter, both of which run after the server has bound it.
  let overridesInstance: OverrideStore | undefined
  const getOverrides = (): OverrideStore => {
    overridesInstance ??= new OverrideStore(join(app.getDataDirPath(), 'pmtiles-overrides.json'))
    return overridesInstance
  }
  let discovery: DiscoveryHandle | undefined
  let mutualExclusionWatcher: MutualExclusionWatcher | undefined
  let chartLifecycle: Promise<void> = Promise.resolve()
  let pmtilesEnabled = false
  // The charts directory resolved from the active config, captured so the override re-apply closure
  // rescans the configured directory, not the default. Set in setupCharts.
  let activeChartsDir: string | undefined

  function chartsDirFor (config: ChartLockerConfig): string {
    const override = readConfigPath('charts.path', config.charts?.path)
    return override ? resolve(configPath, override) : join(configPath, 'charts', 'pmtiles')
  }

  function validateConfig (config: ChartLockerConfig): void {
    const cap = config.tileCache?.cacheCapGiB ?? DEFAULT_CACHE_CAP_GIB
    const budget = config.tileCache?.regionsBudgetGiB ?? 0
    if (!Number.isInteger(cap) || cap < CACHE_CAP_MIN_GIB || cap > CACHE_CAP_MAX_GIB) {
      throw new Error(`cacheCapGiB must be an integer between ${CACHE_CAP_MIN_GIB} and ${CACHE_CAP_MAX_GIB}`)
    }
    if (!Number.isInteger(budget) || budget < 0 || budget > cap) {
      throw new Error('regionsBudgetGiB must be an integer from 0 through cacheCapGiB')
    }
    const chartsPath = readConfigPath('charts.path', config.charts?.path)
    if (chartsPath !== '') {
      const resolved = resolve(configPath, chartsPath)
      const rel = relative(configPath, resolved)
      if (isAbsolute(chartsPath) || rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error('charts.path must stay within the Signal K configuration directory')
      }
    }
    const external = readConfigPath('cacheVolumeSource', config.advanced?.cacheVolumeSource)
    if (external !== '' && !isAbsolute(external)) throw new Error('cacheVolumeSource must be an absolute host path')
    const tag = config.advanced?.imageTag?.trim() ?? ''
    if (tag !== '' && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error('imageTag is not a valid OCI tag')
    if (config.advanced?.geocodingEnabled !== undefined && typeof config.advanced.geocodingEnabled !== 'boolean') {
      throw new Error('geocodingEnabled must be a boolean')
    }
  }

  /**
   * Preserve configurations accepted before the 0.4.3 validation boundary. Older releases allowed
   * cache caps outside the current 4 to 32 GiB range and clamped an oversized regions budget at use
   * time. Migrate only those known-safe nonnegative integer cases; malformed, fractional, and negative
   * values still reach validateConfig and fail closed.
   */
  function migrateLegacyConfig (raw: ChartLockerConfig): ChartLockerConfig {
    const rawCap = raw.tileCache?.cacheCapGiB
    const cacheCapGiB = typeof rawCap === 'number' && Number.isInteger(rawCap) && rawCap >= 0
      ? Math.min(CACHE_CAP_MAX_GIB, Math.max(CACHE_CAP_MIN_GIB, rawCap))
      : rawCap
    const effectiveCap = cacheCapGiB ?? DEFAULT_CACHE_CAP_GIB
    const rawBudget = raw.tileCache?.regionsBudgetGiB
    const regionsBudgetGiB = typeof rawBudget === 'number' && Number.isInteger(rawBudget) && rawBudget >= 0 && rawBudget > effectiveCap
      ? effectiveCap
      : rawBudget
    const rawImageTag = raw.advanced?.imageTag
    const imageTag = migrateLegacyTilecacheTag(rawImageTag)

    if (cacheCapGiB === rawCap && regionsBudgetGiB === rawBudget && imageTag === rawImageTag) return raw
    app.debug(`Migrated legacy configuration to cacheCapGiB=${String(cacheCapGiB)}, regionsBudgetGiB=${String(regionsBudgetGiB)}, imageTag=${String(imageTag)}`)
    return {
      ...raw,
      tileCache: {
        ...raw.tileCache,
        cacheCapGiB,
        regionsBudgetGiB
      },
      advanced: {
        ...raw.advanced,
        imageTag
      }
    }
  }

  async function teardownCharts (): Promise<void> {
    const current = discovery
    discovery = undefined
    try {
      if (current !== undefined) await current.stop()
    } finally {
      registry.clear()
      pmtilesEnabled = false
    }
  }

  async function syncCharts (config: ChartLockerConfig, thirdPartyEnabled = isThirdPartyPmtilesEnabled(configPath)): Promise<void> {
    activeChartsDir = chartsDirFor(config)
    if (thirdPartyEnabled) {
      await teardownCharts()
      return
    }
    registerChartProvider(app as unknown as ChartRouteApp, registry)
    if (discovery !== undefined) {
      pmtilesEnabled = true
      return
    }
    const overrides = getOverrides()
    overrides.load()
    discovery = await (deps.startDiscovery ?? startDiscovery)({
      chartsDir: activeChartsDir,
      allowedRoot: configPath,
      registry,
      namer: overrides.namer(),
      onError: (message) => app.debug(`Chart discovery: ${message}`)
    })
    pmtilesEnabled = true
  }

  function watchMutualExclusion (config: ChartLockerConfig): void {
    if (mutualExclusionWatcher !== undefined) {
      mutualExclusionWatcher.stop().catch((error: unknown) => app.debug('Cannot stop the previous PMTiles mutual-exclusion watcher:', error))
    }
    mutualExclusionWatcher = watchThirdPartyPmtilesEnabled(configPath, async (enabled) => {
      const transition = chartLifecycle
        .catch(() => {})
        .then(() => syncCharts(config, enabled))
        .then(() => updatePluginStatus())
      chartLifecycle = transition
      try {
        await transition
      } catch (error) {
        app.setPluginError(`PMTiles provider update failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }, {
      intervalMs: deps.mutualExclusionPollIntervalMs,
      onError: (error) => app.debug('PMTiles mutual-exclusion watch failed:', error)
    })
  }

  function updatePluginStatus (): void {
    const tcStatus = tilecacheAddress === null
      ? pmtilesEnabled
        ? 'Tilecache container unavailable; tile caching is disabled. PMTiles charts ready.'
        : 'Tilecache container unavailable; tile caching is disabled.'
      : tilecacheHealthDetail !== null
        ? `Tilecache at ${tilecacheAddress}; ${tilecacheHealthDetail}`
        : !tilecacheConfigured
            ? `Tilecache at ${tilecacheAddress}, but its configuration push failed; cached tile requests are unavailable.`
            : !tilecacheHealthy
                ? `Tilecache at ${tilecacheAddress}; health is pending.`
                : `Tilecache at ${tilecacheAddress}; ready.`
    if (!pmtilesEnabled) {
      app.setPluginStatus(`${tcStatus} PMTiles charts disabled: signalk-pmtiles-plugin is enabled, disable it to use the Chart Locker chart provider.`)
    } else {
      app.setPluginStatus(tcStatus)
    }
  }

  async function doStart (rawConfig: ChartLockerConfig): Promise<void> {
    app.setPluginStatus('Starting...')
    const config = migrateLegacyConfig(rawConfig)
    validateConfig(config)
    if (pluginRunning) await doStop()
    const startupController = new AbortController()
    startController = startupController
    pluginRunning = true
    tilecacheHealthy = false
    tilecacheConfigured = false
    tilecacheHealthDetail = null
    geocodingEnabled = config.advanced?.geocodingEnabled ?? true
    configuredCachePath = readConfigPath('cacheVolumeSource', config.advanced?.cacheVolumeSource) || null
    const dataDir = app.getDataDirPath()
    const startupControlToken = getOrCreateControlToken(dataDir)
    controlToken = startupControlToken
    regionsRoutesHandle?.start()
    try {
      const { chartSourceById } = await import('signalk-chart-sources')
      const unavailable = reconcilePositionWarmSources(dataDir, (id) => chartSourceById(id) !== undefined)
      if (unavailable.length > 0) app.debug(`Removed unavailable position-warm sources: ${unavailable.join(', ')}`)
    } catch (error) {
      app.debug('Position-warm source reconciliation failed:', error)
    }

    // PMTiles discovery is independent of the container. Start it before checking the optional
    // tilecache runtime so local charts remain available when signalk-container is absent or offline.
    const chartsReady = syncCharts(config)
    chartLifecycle = chartsReady
    const manager = requireContainerManager(app)
    if (!manager) {
      await chartsReady
      watchMutualExclusion(config)
      updatePluginStatus()
      return
    }
    if (!(await ensureRuntimeReady(app, manager, { signal: startupController.signal }))) {
      await chartsReady
      if (startupController.signal.aborted) return
      watchMutualExclusion(config)
      updatePluginStatus()
      return
    }

    // The tilecache is non-fatal: a failure here disables tile caching but leaves the PMTiles chart
    // provider and the plugin serve routes fully working.
    try {
      const priorTransition = pendingManagerTransition
      if (priorTransition !== null) {
        const priorOutcome = await waitForManagerOperation(priorTransition, managerOperationTimeoutMs, startupController.signal)
        if (priorOutcome.status === 'aborted') {
          await chartsReady
          return
        }
        if (pendingManagerTransition !== null) {
          throw new Error('a previous tilecache manager operation is still pending; skipping this launch')
        }
      }
      const capBytes = (config.tileCache?.cacheCapGiB ?? DEFAULT_CACHE_CAP_GIB) * 1024 ** 3
      // loadRegionsStore always returns cacheScrollTtlDays (default 30 from the store loader), so no
      // fallback is needed here; clamp and convert days to seconds at this edge.
      const scrollTtlSecs = Math.max(0, Math.round(loadRegionsStore(app.getDataDirPath()).cacheScrollTtlDays * 86_400))
      const tilecacheConfig = buildTilecacheConfig({
        tag: config.advanced?.imageTag,
        capBytes,
        scrollTtlSecs,
        controlToken: startupControlToken,
        geocodingEnabled,
        ...(configuredCachePath === null ? {} : { externalCacheVolumeSource: configuredCachePath })
      })
      let requiredVolumeUnavailable = false
      const stopForUnavailableVolume = async (): Promise<void> => {
        tilecacheAddress = null
        tilecacheHealthy = false
        tilecacheConfigured = false
        try {
          const stopOperation = manager.stop(TILECACHE_CONTAINER_NAME)
          const stopOutcome = await waitForManagerOperation(stopOperation, managerOperationTimeoutMs)
          if (stopOutcome.status === 'timeout') {
            trackManagerTransition(stopOperation, 'Timed-out unavailable-volume container stop failed:')
          } else if (stopOutcome.status === 'rejected') {
            app.debug('Cannot stop the tilecache after its required volume became unavailable:', stopOutcome.error)
          }
        } catch (error) {
          app.debug('Cannot stop the tilecache after its required volume became unavailable:', error)
        }
      }
      const tilecacheEnsureOptions: NonNullable<Parameters<typeof manager.ensureRunning>[2]> = {
        pluginId: PLUGIN_ID,
        pluginVersion: PLUGIN_VERSION,
        onVolumeIssue: (event) => {
          if (event.action === 'aborted' && configuredCachePath !== null && event.source === configuredCachePath) {
            requiredVolumeUnavailable = true
            app.setPluginError(`External tile cache path is unavailable: ${event.source}. Create or mount it on the host, grant the effective container-mapped tilecache user read and write access, and restart Chart Locker.`)
          }
        }
      }
      const ensureOperation = manager.ensureRunning(TILECACHE_CONTAINER_NAME, tilecacheConfig, tilecacheEnsureOptions)
      const ensureOutcome = await waitForManagerOperation(ensureOperation, managerOperationTimeoutMs, startupController.signal)
      if (ensureOutcome.status === 'aborted' || ensureOutcome.status === 'timeout') {
        scheduleLateEnsureCleanup(ensureOperation, manager)
        if (ensureOutcome.status === 'aborted') {
          await chartsReady
          return
        }
        throw new Error('tilecache container launch exceeded the manager operation timeout')
      }
      if (ensureOutcome.status === 'rejected') {
        if (requiredVolumeUnavailable) await stopForUnavailableVolume()
        throw ensureOutcome.error
      }
      tilecacheLaunched = true
      tilecacheManager = manager
      // Show update state for this container in the Container Manager panel. Re-registering on
      // every start is the supported pattern, and the detached initial check populates the badge
      // without waiting for the daily scheduled check; offline it resolves from cache without penalty.
      const updates = manager.updates
      if (updates) {
        try {
          registerTilecacheUpdates(updates, config.advanced?.imageTag)
          updates.checkOne(PLUGIN_ID).catch((err: unknown) => {
            app.debug('Initial update check failed:', err)
          })
        } catch (err) {
          app.debug('Update-service registration failed:', err)
        }
      }
      const addressOperation = manager.resolveContainerAddress(TILECACHE_CONTAINER_NAME, TILECACHE_INTERNAL_PORT)
      const addressOutcome = await waitForManagerOperation(addressOperation, managerOperationTimeoutMs, startupController.signal)
      if (addressOutcome.status === 'aborted') {
        await chartsReady
        return
      }
      if (addressOutcome.status === 'timeout') throw new Error('tilecache address resolution exceeded the manager operation timeout')
      if (addressOutcome.status === 'rejected') throw addressOutcome.error
      const tcAddress = addressOutcome.value
      if (tcAddress) {
        tilecacheAddress = tcAddress
        tilecacheHealthy = await probeTilecacheHealth(tcAddress, undefined, startupController.signal)
        if (startupController.signal.aborted) {
          await chartsReady
          return
        }
        if (!tilecacheHealthy) {
          tilecacheHealthDetail = 'startup health probe failed; host-side monitoring is active.'
          app.debug('Tilecache container did not pass its health probe at startup; tiles will work once it is ready.')
        }
        // R, the saved-regions reserve: the configured value (converted from GiB), or half the cap
        // when left at 0 (the default). P, the position-warm slice of R, is derived. Pushed so the
        // container's hard-reserved two-budget accounting is non-zero; without it every region warm
        // immediately caps.
        const rawR = (config.tileCache?.regionsBudgetGiB ?? 0) > 0
          ? config.tileCache!.regionsBudgetGiB! * 1024 ** 3
          : Math.floor(capBytes * 0.5)
        // Clamp R to the cap: a value above the cap makes cap - R negative, so evict_to would drop the
        // whole scroll cache and the pinned bytes could exceed the cap.
        const regionsBudgetBytes = Math.min(rawR, capBytes)
        const pBudget = positionWarmBudgetBytes(regionsBudgetBytes)
        const pushed = await pushTilecacheConfig(
          tcAddress,
          await buildSourcePayload(capBytes, regionsBudgetBytes, pBudget, scrollTtlSecs, geocodingEnabled),
          { controlToken: startupControlToken, signal: startupController.signal }
        )
        if (startupController.signal.aborted) {
          await chartsReady
          return
        }
        tilecacheConfigured = pushed.ok
        if (!pushed.ok) {
          tilecacheHealthDetail = null
          app.debug(`event=tilecache_config_push_failed state=unconfigured status=${String(pushed.status ?? 'network')} error=${pushed.error ?? 'unknown'}`)
        } else {
          app.debug('event=tilecache_config_push_succeeded state=configured')
          // A successful config POST proves the service is reachable; re-probe after the boot-race window
          // so startup status and /tiles/ready reflect the post-configuration state.
          tilecacheHealthy = await probeTilecacheHealth(tcAddress, undefined, startupController.signal)
          if (startupController.signal.aborted) {
            await chartsReady
            return
          }
          tilecacheHealthDetail = tilecacheHealthy
            ? null
            : 'startup health probe failed; host-side monitoring is active.'
        }

        if (tilecacheAddress !== null) {
          const handleHealthState = (state: HostHealthState): void => {
            switch (state.status) {
              case 'healthy':
                tilecacheHealthy = true
                tilecacheHealthDetail = null
                break
              case 'host-unreachable':
                tilecacheHealthy = false
                tilecacheHealthDetail = `host-side health probe failed (${state.failureCount}/${state.failureThreshold}); automatic recovery is pending.`
                break
              case 'restarting':
                tilecacheHealthy = false
                tilecacheConfigured = false
                tilecacheHealthDetail = 'host-side access failed while the container remained healthy; restarting the container.'
                app.debug('event=tilecache_host_recovery_started reason=published_port_unreachable')
                break
              case 'restoring':
                tilecacheHealthy = true
                tilecacheConfigured = false
                tilecacheHealthDetail = 'container configuration is being restored.'
                break
              case 'container-unhealthy':
                tilecacheHealthy = false
                tilecacheHealthDetail = 'host-side and in-container healthchecks failed; inspect the container logs.'
                break
              case 'recovered':
                tilecacheHealthy = true
                tilecacheConfigured = true
                tilecacheHealthDetail = null
                app.debug('event=tilecache_host_recovery_succeeded')
                break
              case 'recovery-failed':
                tilecacheHealthy = false
                tilecacheConfigured = false
                tilecacheHealthDetail = `automatic host-side recovery failed: ${state.error}`
                break
            }
            updatePluginStatus()
          }

          hostHealthMonitor = createHostHealthMonitor({
            getAddress: () => tilecacheAddress,
            probeHost: async (address, signal) => await probeTilecacheHealthStatus(address, undefined, signal),
            probeContainer: async () => {
              const operation = manager.execInContainer(TILECACHE_CONTAINER_NAME, ['/tilecache', 'healthcheck'])
              const outcome = await waitForManagerOperation(operation, managerOperationTimeoutMs)
              return outcome.status === 'completed' && outcome.value.exitCode === 0
            },
            restart: async () => {
              const priorTransition = pendingManagerTransition
              if (priorTransition !== null) {
                await waitForManagerOperation(priorTransition, managerOperationTimeoutMs)
                if (pendingManagerTransition !== null) {
                  throw new Error('a previous tilecache manager operation is still pending; skipping recovery recreation')
                }
              }
              // recreate is one manager-owned transition that replaces the wedged port forward and
              // re-registers Signal K accessible-port bookkeeping. A separate stop/start sequence
              // can strand the service when either half completes after its caller times out.
              const recreateOperation = manager.recreate(TILECACHE_CONTAINER_NAME, tilecacheConfig, tilecacheEnsureOptions)
              const recreateOutcome = await waitForManagerOperation(recreateOperation, managerOperationTimeoutMs)
              if (recreateOutcome.status === 'timeout') {
                scheduleLateEnsureCleanup(recreateOperation, manager)
                throw new Error('container recreation exceeded the manager operation timeout')
              }
              if (recreateOutcome.status === 'rejected') {
                if (requiredVolumeUnavailable) await stopForUnavailableVolume()
                throw recreateOutcome.error
              }

              const addressOperation = manager.resolveContainerAddress(TILECACHE_CONTAINER_NAME, TILECACHE_INTERNAL_PORT)
              const addressOutcome = await waitForManagerOperation(addressOperation, managerOperationTimeoutMs)
              if (addressOutcome.status === 'timeout') throw new Error('container address resolution exceeded the manager operation timeout')
              if (addressOutcome.status === 'rejected') throw addressOutcome.error
              return addressOutcome.status === 'completed' ? addressOutcome.value : null
            },
            restore: async (address, signal) => {
              const restored = await pushTilecacheConfig(
                address,
                await buildSourcePayload(capBytes, regionsBudgetBytes, pBudget, scrollTtlSecs, geocodingEnabled),
                { controlToken: startupControlToken, signal }
              )
              if (!restored.ok) {
                app.debug(`event=tilecache_config_push_failed state=recovery status=${String(restored.status ?? 'network')} error=${restored.error ?? 'unknown'}`)
                throw new Error(`configuration restore failed: ${restored.error ?? String(restored.status ?? 'network error')}`)
              }
              app.debug('event=tilecache_config_push_succeeded state=recovered')
            },
            restoreInitially: !tilecacheConfigured,
            onAddress: (address) => { tilecacheAddress = address },
            onState: handleHealthState,
            onError: (error) => { app.debug('Tilecache host-side health monitor:', error) },
            ...(deps.hostHealthMonitorIntervalMs === undefined ? {} : { intervalMs: deps.hostHealthMonitorIntervalMs }),
            ...(deps.hostHealthFailureThreshold === undefined ? {} : { failureThreshold: deps.hostHealthFailureThreshold }),
            ...(deps.hostHealthRecoveryCooldownMs === undefined ? {} : { recoveryCooldownMs: deps.hostHealthRecoveryCooldownMs })
          })
          hostHealthMonitor.start()
        }
      }
    } catch (err) {
      app.debug('Tilecache container did not start; tile caching is disabled:', err)
    }

    // Reconcile durable metadata with the cache in one transaction. Downloading regions are retained:
    // the route-owned background reconciler recovers their latest retained container job by region id.
    const regionTotals = tilecacheAddress === null ? null : await getRegionByteTotals(tilecacheAddress, fetch, startupController.signal)
    if (startupController.signal.aborted) {
      await chartsReady
      return
    }
    if (regionTotals !== null) {
      mutateRegionsStore(dataDir, (store) => {
        store.regions = store.regions.map((region) => {
          if (region.status === 'downloading' || region.status === 'needs-redownload') return region
          const authoritativeBytes = regionTotals[region.id] ?? 0
          if ((region.status === 'ready' || region.status === 'capped') && region.bytes > 0 && authoritativeBytes === 0) {
            return { ...region, status: 'needs-redownload', bytes: 0 }
          }
          return region.bytes === authoritativeBytes ? region : { ...region, bytes: authoritativeBytes }
        })
      })
    }
    const regionsLoader = createCachedRegionsLoader(dataDir)
    regionsLoaderStop = regionsLoader.stop
    warmer = createPositionWarmer({
      getStore: regionsLoader.getStore,
      onError: (error) => { app.debug('Cannot read position-warm state:', error) },
      warm: async (bbox, sources, minzoom, maxzoom, _regionId, additionalBbox, signal) => {
        const address = tilecacheConfigured ? tilecacheAddress : null
        if (address === null) return null
        return warmRegion(address, { bbox, additionalBbox, sources, minzoom, maxzoom, regionId: POSITION_WARM_REGION_ID }, fetch, startupControlToken, signal)
      }
    })
    positionUnsub = app.streambundle.getSelfBus('navigation.position' as unknown as Parameters<typeof app.streambundle.getSelfBus>[0])
      .onValue((delta: { value: unknown, timestamp?: unknown }) => {
        const timestamp = typeof delta.timestamp === 'number'
          ? delta.timestamp
          : typeof delta.timestamp === 'string'
            ? Date.parse(delta.timestamp)
            : Date.now()
        const ageMs = Date.now() - timestamp
        if (isValidPosition(delta.value) && Number.isFinite(timestamp) && ageMs >= -30_000 && ageMs <= 120_000) warmer?.onPosition(delta.value)
      })

    await chartsReady
    watchMutualExclusion(config)
    updatePluginStatus()
  }

  async function doStop (): Promise<void> {
    pluginRunning = false
    startController?.abort()
    startController = null
    const monitor = hostHealthMonitor
    hostHealthMonitor = null
    if (monitor !== null) {
      try { await monitor.stop() } catch (error) { app.debug('Cannot stop the tilecache host-side health monitor:', error) }
    }
    if (positionUnsub) {
      try { positionUnsub() } catch (error) { app.debug('Cannot stop the position subscription:', error) }
      positionUnsub = null
    }
    if (warmer !== null) {
      try { await warmer.stop() } catch (error) { app.debug('Cannot stop position warming:', error) }
      warmer = null
    }
    if (regionsLoaderStop) {
      try { regionsLoaderStop() } catch (error) { app.debug('Cannot stop the regions loader:', error) }
      regionsLoaderStop = null
    }
    const watcher = mutualExclusionWatcher
    mutualExclusionWatcher = undefined
    if (watcher !== undefined) {
      try { await watcher.stop() } catch (error) { app.debug('Cannot stop the PMTiles mutual-exclusion watcher:', error) }
    }
    try { await chartLifecycle } catch (error) { app.debug('PMTiles provider transition failed during teardown:', error) }
    chartLifecycle = Promise.resolve()
    try { await teardownCharts() } catch (error) { app.debug('Cannot stop PMTiles discovery:', error) }
    if (regionsRoutesHandle !== null) {
      try { await regionsRoutesHandle.stop() } catch (error) { app.debug('Cannot stop saved-region reconciliation:', error) }
    }

    // Clear the tilecache address first so the proxy routes report unavailable, then stop its container.
    tilecacheAddress = null
    tilecacheHealthy = false
    tilecacheConfigured = false
    tilecacheHealthDetail = null
    if (tilecacheLaunched) {
      let manager = tilecacheManager
      if (manager === null) {
        try { manager = getContainerManager() } catch (error) { app.debug('Cannot access the container manager during teardown:', error); manager = null }
      }
      if (manager) {
        const updates = manager.updates
        if (updates) {
          try {
            unregisterTilecacheUpdates(updates)
          } catch (err) {
            app.debug('Update-service unregister failed:', err)
          }
        }
        try {
          const stopOperation = manager.stop(TILECACHE_CONTAINER_NAME)
          trackManagerTransition(stopOperation, 'Failed to stop tilecache container:')
          const stopOutcome = await waitForManagerOperation(stopOperation, managerOperationTimeoutMs)
          if (stopOutcome.status === 'timeout') app.debug('Stopping the tilecache container exceeded the manager operation timeout.')
          else if (stopOutcome.status === 'rejected') app.debug('Failed to stop tilecache container:', stopOutcome.error)
        } catch (err) {
          app.debug('Failed to stop tilecache container:', err)
        }
      }
      tilecacheLaunched = false
      tilecacheManager = null
    }
    controlToken = null
    configuredCachePath = null
    activeChartsDir = undefined
  }

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    schema: () => {
      // Detect free space on the Signal K data directory to seed a sensible default cap.
      // schema() is re-invoked each time the admin UI fetches config, and by then the server has
      // bound getDataDirPath onto the app copy. Guard the early-call case (an unbound
      // getDataDirPath throws) and any statfs failure, falling back to the static default.
      let capDefaultGiB = DEFAULT_CACHE_CAP_GIB
      try {
        const dataDir = app.getDataDirPath()
        capDefaultGiB = deriveDefaultCapGiB(readFreeGiB(dataDir))
      } catch {
        // Detection failed (early call or a platform without statfs): keep the conservative default.
      }
      return {
        type: 'object',
        // The Signal K admin UI (rjsf) renders this top-level description as the form preamble, so it
        // is the intro. Nested object properties below render as titled sections.
        description: 'Chart Locker runs a tile cache and proxy container alongside Signal K and serves your local PMTiles charts. Set the cache size and the saved-regions budget below. Most installs need no other changes.',
        properties: {
          tileCache: {
            type: 'object',
            title: 'Tile cache',
            description: 'The on-disk cache for map tiles, plus the budget reserved for saved regions you keep for offline use.',
            properties: {
              cacheCapGiB: {
                type: 'integer',
                multipleOf: 1,
                minimum: CACHE_CAP_MIN_GIB,
                maximum: CACHE_CAP_MAX_GIB,
                title: 'Cache size cap (GiB)',
                description: 'The most disk space the tile cache may use. When it reaches this size it evicts the least recently used unpinned tiles to stay under the cap.',
                default: capDefaultGiB
              },
              regionsBudgetGiB: {
                type: 'integer',
                multipleOf: 1,
                minimum: 0,
                title: 'Saved-regions reserved budget (GiB)',
                description: 'A ceiling on how much of the cache saved regions may pin. Leave 0 to reserve half the cache cap.',
                default: 0
              }
            }
          },
          charts: {
            type: 'object',
            title: 'Charts',
            description: 'Local PMTiles charts served by the plugin.',
            properties: {
              path: {
                type: 'string',
                maxLength: MAX_CONFIG_PATH_LENGTH,
                title: 'PMTiles charts directory',
                description: 'Directory holding .pmtiles charts, relative to the Signal K config path. Leave blank for the default charts/pmtiles.',
                default: ''
              }
            }
          },
          advanced: {
            type: 'object',
            title: 'Advanced',
            description: 'Settings most installs never change.',
            properties: {
              imageTag: {
                type: 'string',
                title: 'Tile cache container image tag',
                description: 'The image tag to run for the tile cache and proxy container. Pinned to the plugin version, so change it only to test a specific build.',
                default: ''
              },
              cacheVolumeSource: {
                type: 'string',
                maxLength: MAX_CONFIG_PATH_LENGTH,
                title: 'External tile cache drive',
                description: 'Host path of a USB SSD or NVMe drive to hold the tile cache. Leave blank to keep the cache on the Signal K data directory.',
                default: ''
              },
              geocodingEnabled: {
                type: 'boolean',
                title: 'Enable reverse geocoding',
                description: 'Allow the tilecache container to contact its reverse-geocoding provider. Disable this to prevent geocoding network egress.',
                default: true
              }
            }
          }
        }
      }
    },
    uiSchema: {
      'ui:order': ['tileCache', 'charts', 'advanced'],
      tileCache: {
        'ui:order': ['cacheCapGiB', 'regionsBudgetGiB'],
        cacheCapGiB: {
          'ui:widget': 'range',
          'ui:help': 'Defaults to about 80 percent of the free space detected on the Signal K data directory when this form loaded, floored to the nearest 4 GiB to leave headroom, and capped at 32 GiB. The Chart Locker settings panel moves this in 4 GiB steps. Do not set this to all of your free space: the cache grows to fill the cap, and a full disk can stop the server from writing. If you move the cache to an external drive under Advanced, this value reflects the data directory filesystem, not the drive, so set the cap to suit the drive.'
        },
        regionsBudgetGiB: {
          'ui:widget': 'updown',
          'ui:help': 'This is not space taken from the scroll cache until a region is actually saved. The value must not exceed the cache cap.'
        }
      },
      charts: {
        'ui:order': ['path']
      },
      advanced: {
        'ui:order': ['imageTag', 'cacheVolumeSource', 'geocodingEnabled']
      }
    },
    // Signal K calls start synchronously and does not await it, so the async work runs detached with
    // an explicit catch: a doStart rejection surfaces as a plugin error instead of an unhandled
    // rejection. Chaining onto the shared lifecycle promise serializes this start after any in-flight
    // stop, so a stop() queued before this start() always completes before doStart runs.
    start (config: ChartLockerConfig) {
      lifecycle = lifecycle
        .then(() => doStart(config))
        .catch(async (err: unknown) => {
          app.setPluginError(`Startup failed: ${err instanceof Error ? err.message : String(err)}`)
          await doStop()
        })
        .finally(() => { startController = null })
      return lifecycle
    },
    // Chaining onto the shared lifecycle serializes this stop after any in-flight start, so a
    // start() that was in flight when stop() was called always completes before doStop runs.
    // doStop never throws, so the chain always resolves and subsequent transitions are not blocked.
    stop () {
      startController?.abort()
      lifecycle = lifecycle.then(() => doStop())
      return lifecycle
    },
    // Mount the tile and style proxy through the readonly scope when the server supports scoped plugin
    // routers. Released servers without access() keep the fallback routes inside their blanket
    // administrator-only plugin mount. Management routes stay admin-gated and fail closed.
    registerWithRouter (router) {
      const accessRouter = router as unknown as AccessAwarePluginRouter
      const readRouter = accessRouter.access?.('readonly') ?? router
      const getConfiguredAddress = (): string | null => tilecacheConfigured ? tilecacheAddress : null
      const getAdminAddress = (): string | null => tilecacheAddress
      registerTileRoutes(
        readRouter as TileRouter,
        getConfiguredAddress,
        undefined,
        PLUGIN_MOUNT_PATH,
        () => tilecacheConfigured && tilecacheHealthy && tilecacheAddress !== null
      )
      const routesHandle = (deps.registerRegionsRoutes ?? registerRegionsRoutes)(router as unknown as RegionsRouter, app, getAdminAddress, {
        getControlToken: () => controlToken,
        isGeocodingEnabled: () => geocodingEnabled
      })
      if (routesHandle !== false) {
        regionsRoutesHandle = routesHandle
        if (pluginRunning) routesHandle.start()
      }
      registerCacheInfoRoute(router as unknown as CacheInfoRouter, app, { cachePath: () => configuredCachePath })
      registerPmtilesServeRoute(readRouter as ServeRouter, registry, () => pmtilesEnabled)
      registerChartManagementRoutes(
        router as unknown as ManagementRouter,
        app,
        registry,
        getOverrides(),
        () => discovery?.rescan() ?? Promise.resolve(),
        () => pmtilesEnabled
      )
    }
  }
}
