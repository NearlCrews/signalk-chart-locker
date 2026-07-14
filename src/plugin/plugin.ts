/** The plugin factory: lifecycle that launches the tilecache container and registers chart providers. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_MOUNT_PATH } from '../shared/plugin-id.js'
import { requireContainerManager, getContainerManager, ensureRuntimeReady } from '../runtime/container-manager.js'
import { TILECACHE_CONTAINER_NAME, TILECACHE_INTERNAL_PORT, DEFAULT_TILECACHE_TAG, DEFAULT_CACHE_CAP_GIB, PLUGIN_VERSION, buildTilecacheConfig, probeTilecacheHealth, registerTilecacheUpdates, unregisterTilecacheUpdates } from '../runtime/tilecache-container.js'
import { buildSourcePayload, pushTilecacheConfig } from '../runtime/tilecache-config-push.js'
import { registerTileRoutes, type TileRouter } from '../http/tile-routes.js'
import { registerRegionsRoutes, type RegionsRouter } from '../http/regions-routes.js'
import { registerCacheInfoRoute, type CacheInfoRouter } from '../http/cache-info-route.js'
import { ChartRegistry, registerChartProvider, type ChartRouteApp } from '../charts/chart-registry.js'
import { type DiscoveryHandle, rescanCharts, startDiscovery } from '../charts/discovery.js'
import { isThirdPartyPmtilesEnabled } from '../charts/mutual-exclusion.js'
import { registerPmtilesServeRoute, type ServeRouter } from '../http/pmtiles-routes.js'
import { registerChartManagementRoutes, type ManagementRouter } from '../http/chart-management-routes.js'
import { OverrideStore } from '../charts/overrides.js'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readFreeGiB } from '../runtime/free-space.js'
import { CACHE_CAP_MAX_GIB, CACHE_CAP_MIN_GIB, deriveDefaultCapGiB } from '../shared/cache-cap.js'
import { createPositionWarmer, type PositionWarmer } from '../runtime/position-warmer.js'
import { loadRegionsStore, updateRegion, createCachedRegionsLoader, POSITION_WARM_REGION_ID, positionWarmBudgetBytes } from '../runtime/regions-store.js'
import { getRegionByteTotals, warmRegion } from '../runtime/tilecache-client.js'
import { isValidPosition } from '../runtime/position-warm.js'

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
  }
}

interface AccessAwarePluginRouter {
  access?: (level: 'readonly') => unknown
}

export function createPlugin (app: ServerAPI): Plugin {
  // All lifecycle transitions are serialized through this chain. It always resolves: errors from
  // doStart are caught in start(), and doStop never throws. This eliminates the concurrent-call
  // race where stop() setting a flag could be undone by a subsequent start() resetting it.
  let lifecycle: Promise<void> = Promise.resolve()
  // The tilecache container is non-fatal: the PMTiles chart provider and the plugin serve routes
  // work even if the tilecache container fails to start; only the tile cache and proxy are disabled.
  // Its address is held for the proxy routes.
  let tilecacheLaunched = false
  let tilecacheAddress: string | null = null
  let configuredCachePath: string | null = null
  let tilecacheHealthy = false
  let tilecacheConfigured = false
  // Position-warm lifecycle state (factory scope, like tilecacheAddress).
  let positionUnsub: (() => void) | null = null
  let warmer: PositionWarmer | null = null
  // Closes the cached regions loader's filesystem watcher at teardown.
  let regionsLoaderStop: (() => void) | null = null

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
  let pmtilesEnabled = false
  // The charts directory resolved from the active config, captured so the override re-apply closure
  // rescans the configured directory, not the default. Set in setupCharts.
  let activeChartsDir: string | undefined

  function chartsDirFor (config: ChartLockerConfig): string {
    const override = config.charts?.path?.trim()
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
    const chartsPath = config.charts?.path?.trim() ?? ''
    if (chartsPath !== '') {
      const resolved = resolve(configPath, chartsPath)
      const rel = relative(configPath, resolved)
      if (isAbsolute(chartsPath) || rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error('charts.path must stay within the Signal K configuration directory')
      }
    }
    const external = config.advanced?.cacheVolumeSource?.trim() ?? ''
    if (external !== '' && !isAbsolute(external)) throw new Error('cacheVolumeSource must be an absolute host path')
    const tag = config.advanced?.imageTag?.trim() ?? ''
    if (tag !== '' && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error('imageTag is not a valid OCI tag')
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

    if (cacheCapGiB === rawCap && regionsBudgetGiB === rawBudget) return raw
    app.debug(`Migrated legacy cache limits to cacheCapGiB=${String(cacheCapGiB)}, regionsBudgetGiB=${String(regionsBudgetGiB)}`)
    return {
      ...raw,
      tileCache: {
        ...raw.tileCache,
        cacheCapGiB,
        regionsBudgetGiB
      }
    }
  }

  async function setupCharts (config: ChartLockerConfig): Promise<void> {
    if (isThirdPartyPmtilesEnabled(configPath)) {
      pmtilesEnabled = false
      activeChartsDir = undefined
      registry.clear()
      return
    }
    pmtilesEnabled = true
    activeChartsDir = chartsDirFor(config)
    const overrides = getOverrides()
    overrides.load()
    registerChartProvider(app as unknown as ChartRouteApp, registry)
    discovery = await startDiscovery({
      chartsDir: activeChartsDir,
      registry,
      namer: overrides.namer(),
      onError: (message) => app.debug(`Chart discovery: ${message}`)
    })
  }

  function teardownCharts (): void {
    discovery?.stop()
    discovery = undefined
    registry.clear()
    pmtilesEnabled = false
  }

  async function doStart (rawConfig: ChartLockerConfig): Promise<void> {
    app.setPluginStatus('Starting...')
    const config = migrateLegacyConfig(rawConfig)
    validateConfig(config)
    tilecacheHealthy = false
    tilecacheConfigured = false
    configuredCachePath = config.advanced?.cacheVolumeSource?.trim() || null

    // PMTiles discovery is independent of the container. Start it before checking the optional
    // tilecache runtime so local charts remain available when signalk-container is absent or offline.
    const chartsReady = setupCharts(config)
    const manager = requireContainerManager(app)
    if (!manager) {
      await chartsReady
      app.setPluginStatus(pmtilesEnabled
        ? 'PMTiles charts ready; tile caching is disabled because signalk-container is unavailable.'
        : 'Tile caching unavailable. PMTiles charts disabled while pmtiles-chart-provider is enabled.')
      return
    }
    if (!(await ensureRuntimeReady(app, manager))) {
      await chartsReady
      app.setPluginStatus(pmtilesEnabled
        ? 'PMTiles charts ready; tile caching is disabled because no container runtime is available.'
        : 'Tile caching unavailable. PMTiles charts disabled while pmtiles-chart-provider is enabled.')
      return
    }

    // The tilecache is non-fatal: a failure here disables tile caching but leaves the PMTiles chart
    // provider and the plugin serve routes fully working.
    try {
      const capBytes = (config.tileCache?.cacheCapGiB ?? DEFAULT_CACHE_CAP_GIB) * 1024 ** 3
      // loadRegionsStore always returns cacheScrollTtlDays (default 30 from the store loader), so no
      // fallback is needed here; clamp and convert days to seconds at this edge.
      const scrollTtlSecs = Math.max(0, Math.round(loadRegionsStore(app.getDataDirPath()).cacheScrollTtlDays * 86_400))
      const tilecacheConfig = buildTilecacheConfig({
        tag: config.advanced?.imageTag,
        capBytes,
        scrollTtlSecs,
        ...(config.advanced?.cacheVolumeSource?.trim() ? { externalCacheVolumeSource: config.advanced.cacheVolumeSource.trim() } : {})
      })
      await manager.ensureRunning(TILECACHE_CONTAINER_NAME, tilecacheConfig, { pluginId: PLUGIN_ID, pluginVersion: PLUGIN_VERSION })
      tilecacheLaunched = true
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
      const tcAddress = await manager.resolveContainerAddress(TILECACHE_CONTAINER_NAME, TILECACHE_INTERNAL_PORT)
      if (tcAddress) {
        tilecacheAddress = tcAddress
        tilecacheHealthy = await probeTilecacheHealth(tcAddress)
        if (!tilecacheHealthy) {
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
        const pushed = await pushTilecacheConfig(tcAddress, await buildSourcePayload(capBytes, regionsBudgetBytes, pBudget, scrollTtlSecs))
        tilecacheConfigured = pushed
        if (!pushed) {
          app.debug('event=tilecache_config_push_failed state=unconfigured')
        } else {
          app.debug('event=tilecache_config_push_succeeded state=configured')
        }
      }
    } catch (err) {
      app.debug('Tilecache container did not start; tile caching is disabled:', err)
    }

    // Load (and migrate) the regions store once, then sweep any region left mid-download across a
    // restart to error: the container's in-memory warm-job registry does not survive a restart, so a
    // region caught downloading is a lost job and must never stay downloading.
    const dataDir = app.getDataDirPath()
    const regionTotals = tilecacheAddress === null ? null : await getRegionByteTotals(tilecacheAddress)
    for (const region of loadRegionsStore(dataDir).regions) {
      if (region.status === 'downloading') {
        updateRegion(dataDir, region.id, { status: 'error' })
      } else if (
        regionTotals !== null &&
        (region.status === 'ready' || region.status === 'capped') &&
        region.bytes > 0 &&
        (regionTotals[region.id] ?? 0) === 0
      ) {
        // The disposable cache was recreated or upgraded while durable region metadata survived.
        // Never advertise the region as offline-ready when none of its pins remain.
        updateRegion(dataDir, region.id, { status: 'needs-redownload', bytes: 0 })
      }
    }
    const regionsLoader = createCachedRegionsLoader(dataDir)
    regionsLoaderStop = regionsLoader.stop
    warmer = createPositionWarmer({
      getStore: regionsLoader.getStore,
      warm: async (bbox, sources, minzoom, maxzoom, _regionId, additionalBbox) => {
        const address = tilecacheAddress
        if (address === null) return null
        return warmRegion(address, { bbox, additionalBbox, sources, minzoom, maxzoom, regionId: POSITION_WARM_REGION_ID })
      }
    })
    positionUnsub = app.streambundle.getSelfBus('navigation.position' as unknown as Parameters<typeof app.streambundle.getSelfBus>[0])
      .onValue((delta: { value: unknown }) => {
        if (isValidPosition(delta.value)) warmer?.onPosition(delta.value)
      })

    await chartsReady

    const tcStatus = tilecacheAddress === null
      ? 'Tilecache container unavailable; tile caching is disabled.'
      : !tilecacheConfigured
          ? `Tilecache at ${tilecacheAddress}, but its configuration push failed; cached tile requests are unavailable.`
          : !tilecacheHealthy
              ? `Tilecache at ${tilecacheAddress}; startup health is still pending.`
              : `Tilecache at ${tilecacheAddress}; ready.`
    if (!pmtilesEnabled) {
      app.setPluginStatus(`${tcStatus} PMTiles charts disabled: signalk-pmtiles-plugin is enabled, disable it to use the Chart Locker chart provider.`)
    } else {
      app.setPluginStatus(tcStatus)
    }
  }

  async function doStop (): Promise<void> {
    if (positionUnsub) { positionUnsub(); positionUnsub = null }
    if (regionsLoaderStop) { regionsLoaderStop(); regionsLoaderStop = null }
    warmer = null
    teardownCharts()

    // Clear the tilecache address first so the proxy routes report unavailable, then stop its container.
    tilecacheAddress = null
    tilecacheHealthy = false
    tilecacheConfigured = false
    if (tilecacheLaunched) {
      const manager = getContainerManager()
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
          await manager.stop(TILECACHE_CONTAINER_NAME)
        } catch (err) {
          app.debug('Failed to stop tilecache container:', err)
        }
      }
      tilecacheLaunched = false
    }
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
                default: DEFAULT_TILECACHE_TAG
              },
              cacheVolumeSource: {
                type: 'string',
                title: 'External tile cache drive',
                description: 'Host path of a USB SSD or NVMe drive to hold the tile cache. Leave blank to keep the cache on the Signal K data directory.',
                default: ''
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
        'ui:order': ['imageTag', 'cacheVolumeSource']
      }
    },
    // Signal K calls start synchronously and does not await it, so the async work runs detached with
    // an explicit catch: a doStart rejection surfaces as a plugin error instead of an unhandled
    // rejection. Chaining onto the shared lifecycle promise serializes this start after any in-flight
    // stop, so a stop() queued before this start() always completes before doStart runs.
    start (config: ChartLockerConfig) {
      lifecycle = lifecycle.then(() => doStart(config)).catch((err: unknown) => {
        app.setPluginError(`Startup failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      return lifecycle
    },
    // Chaining onto the shared lifecycle serializes this stop after any in-flight start, so a
    // start() that was in flight when stop() was called always completes before doStop runs.
    // doStop never throws, so the chain always resolves and subsequent transitions are not blocked.
    stop () {
      lifecycle = lifecycle.then(() => doStop())
      return lifecycle
    },
    // Mount the tile and style proxy on the Signal K server so every authenticated Signal K user can
    // reach cached charts while the container remains plugin-only. Current servers record these GET
    // routes as readonly permissions. Older servers do not expose access(), and retain their original
    // direct-route behavior through the fallback. Management routes stay admin-gated and fail closed.
    registerWithRouter (router) {
      const accessRouter = router as unknown as AccessAwarePluginRouter
      const readRouter = accessRouter.access?.('readonly') ?? router
      registerTileRoutes(readRouter as TileRouter, () => tilecacheAddress, undefined, PLUGIN_MOUNT_PATH)
      registerRegionsRoutes(router as unknown as RegionsRouter, app, () => tilecacheAddress)
      registerCacheInfoRoute(router as unknown as CacheInfoRouter, app, { cachePath: () => configuredCachePath })
      registerPmtilesServeRoute(readRouter as ServeRouter, registry, () => pmtilesEnabled)
      registerChartManagementRoutes(
        router as unknown as ManagementRouter,
        app,
        registry,
        getOverrides(),
        () => rescanCharts({
          chartsDir: activeChartsDir ?? chartsDirFor({}),
          registry,
          namer: getOverrides().namer(),
          onError: (message) => app.debug(`Chart discovery: ${message}`)
        }),
        () => pmtilesEnabled
      )
    }
  }
}
