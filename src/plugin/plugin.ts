/** The plugin factory: lifecycle that launches the tilecache container and registers chart providers. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { Position } from '../shared/types.js'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION } from '../shared/plugin-id.js'
import { requireContainerManager, getContainerManager, ensureRuntimeReady } from '../runtime/container-manager.js'
import { TILECACHE_CONTAINER_NAME, TILECACHE_INTERNAL_PORT, DEFAULT_TILECACHE_TAG, DEFAULT_CACHE_CAP_GIB, buildTilecacheConfig, probeTilecacheHealth } from '../runtime/tilecache-container.js'
import { buildSourcePayload, pushTilecacheConfig } from '../runtime/tilecache-config-push.js'
import { registerTileRoutes, type TileRouter } from '../http/tile-routes.js'
import { registerRegionsRoutes, type RegionsRouter } from '../http/regions-routes.js'
import { ChartRegistry, registerChartProvider, type ChartRouteApp } from '../charts/chart-registry.js'
import { type DiscoveryHandle, startDiscovery } from '../charts/discovery.js'
import { isThirdPartyPmtilesEnabled } from '../charts/mutual-exclusion.js'
import { registerPmtilesServeRoute, type ServeRouter } from '../http/pmtiles-routes.js'
import { registerChartManagementRoutes, type ManagementRouter } from '../http/chart-management-routes.js'
import { OverrideStore } from '../charts/overrides.js'
import { ensureApiAdminGate } from '../shared/admin-gate.js'
import { join, resolve } from 'node:path'
import { statfsSync } from 'node:fs'
import { createPositionWarmer, type PositionWarmer } from '../runtime/position-warmer.js'
import { loadRegionsStore, listRegions, updateRegion, POSITION_WARM_REGION_ID, positionWarmBudgetBytes } from '../runtime/regions-store.js'
import { warmRegion } from '../runtime/tilecache-client.js'

interface CompanionConfig {
  tilecacheImageTag?: string
  tilecacheCacheCapGiB?: number
  tilecacheRegionsBudgetGiB?: number
  tilecacheCacheVolumeSource?: string
  chartsPath?: string
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
  // Position-warm lifecycle state (factory scope, like tilecacheAddress).
  let positionUnsub: (() => void) | null = null
  let warmer: PositionWarmer | null = null

  interface ConfigAwareApp { config: { configPath: string } }
  const configPath = (app as unknown as ConfigAwareApp).config.configPath
  const registry = new ChartRegistry()
  // getDataDirPath is bound by the Signal K server onto the per-plugin app copy AFTER the plugin
  // factory runs (interfaces/plugins.js constructs the plugin, then assigns getDataDirPath), so it must
  // not be called here at construction time. Build the override store lazily on first use, which happens
  // in doStart or registerWithRouter, both of which run after the server has bound it.
  let overridesInstance: OverrideStore | undefined
  const getOverrides = (): OverrideStore => {
    overridesInstance ??= new OverrideStore(join((app as unknown as { getDataDirPath: () => string }).getDataDirPath(), 'pmtiles-overrides.json'))
    return overridesInstance
  }
  let discovery: DiscoveryHandle | undefined
  // The charts directory resolved from the active config, captured so the override re-apply closure
  // rescans the configured directory, not the default. Set in setupCharts.
  let activeChartsDir: string | undefined
  // Single-flight guard: at most one rescan runs at a time. The override-triggered rescan and the
  // discovery watcher can both call rescanCharts on the same ChartRegistry; concurrent runs are
  // redundant and can race. A new trigger while a rescan is in progress is a no-op (the running
  // rescan will see the latest overrides because it reads them at execution time).
  let rescanInProgress = false

  function chartsDirFor (config: CompanionConfig): string {
    const override = config.chartsPath?.trim()
    return override ? resolve(configPath, override) : join(configPath, 'charts', 'pmtiles')
  }

  async function setupCharts (config: CompanionConfig): Promise<void> {
    if (isThirdPartyPmtilesEnabled(configPath)) {
      return
    }
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
  }

  async function doStart (config: CompanionConfig): Promise<void> {
    app.setPluginStatus('Starting...')
    const manager = requireContainerManager(app)
    if (!manager) return
    if (!(await ensureRuntimeReady(app, manager))) return

    // The tilecache is non-fatal: a failure here disables tile caching but leaves the PMTiles chart
    // provider and the plugin serve routes fully working.
    try {
      const capBytes = (config.tilecacheCacheCapGiB ?? DEFAULT_CACHE_CAP_GIB) * 1024 ** 3
      // loadRegionsStore always returns cacheScrollTtlDays (default 30 from the store loader), so no
      // fallback is needed here; clamp and convert days to seconds at this edge.
      const scrollTtlSecs = Math.max(0, Math.round(loadRegionsStore(app.getDataDirPath()).cacheScrollTtlDays * 86_400))
      const tilecacheConfig = buildTilecacheConfig({
        tag: config?.tilecacheImageTag?.trim() || undefined,
        capBytes,
        scrollTtlSecs,
        ...(config?.tilecacheCacheVolumeSource?.trim() ? { externalCacheVolumeSource: config.tilecacheCacheVolumeSource.trim() } : {})
      })
      await manager.ensureRunning(TILECACHE_CONTAINER_NAME, tilecacheConfig, { pluginId: PLUGIN_ID })
      tilecacheLaunched = true
      const tcAddress = await manager.resolveContainerAddress(TILECACHE_CONTAINER_NAME, TILECACHE_INTERNAL_PORT)
      if (tcAddress) {
        tilecacheAddress = tcAddress
        if (!(await probeTilecacheHealth(tcAddress))) {
          app.debug('Tilecache container did not pass its health probe at startup; tiles will work once it is ready.')
        }
        // R, the saved-regions reserve: the configured value (converted from GiB), or half the cap
        // when left at 0 (the default). P, the position-warm slice of R, is derived. Pushed so the
        // container's hard-reserved two-budget accounting is non-zero; without it every region warm
        // immediately caps.
        const rawR = (config.tilecacheRegionsBudgetGiB ?? 0) > 0
          ? config.tilecacheRegionsBudgetGiB! * 1024 ** 3
          : Math.floor(capBytes * 0.5)
        // Clamp R to the cap: a value above the cap makes cap - R negative, so evict_to would drop the
        // whole scroll cache and the pinned bytes could exceed the cap.
        const regionsBudgetBytes = Math.min(rawR, capBytes)
        const pBudget = positionWarmBudgetBytes(regionsBudgetBytes)
        const pushed = await pushTilecacheConfig(tcAddress, buildSourcePayload(capBytes, regionsBudgetBytes, pBudget, scrollTtlSecs))
        if (!pushed) {
          app.debug('Tilecache config push failed; the proxy has an empty allowlist until the next push.')
        }
      }
    } catch (err) {
      app.debug('Tilecache container did not start; tile caching is disabled:', err)
    }

    // Eagerly load (and migrate) the regions store, then sweep any region left mid-download across a
    // restart to error: the container's in-memory warm-job registry does not survive a restart, so a
    // region caught downloading is a lost job and must never stay downloading.
    const dataDir = app.getDataDirPath()
    loadRegionsStore(dataDir)
    for (const region of listRegions(dataDir)) {
      if (region.status === 'downloading') {
        updateRegion(dataDir, region.id, { status: 'error' })
      }
    }
    warmer = createPositionWarmer({
      getStore: () => loadRegionsStore(app.getDataDirPath()),
      warm: async (bbox, sources, minzoom, maxzoom) => {
        const address = tilecacheAddress
        if (address === null) return null
        return warmRegion(address, { bbox, sources, minzoom, maxzoom, regionId: POSITION_WARM_REGION_ID })
      }
    })
    positionUnsub = app.streambundle.getSelfBus('navigation.position' as unknown as Parameters<typeof app.streambundle.getSelfBus>[0])
      .onValue((delta: { value: unknown }) => { warmer?.onPosition(delta.value as Position) })

    await setupCharts(config)

    const tcStatus = tilecacheAddress !== null
      ? `Tilecache at ${tilecacheAddress}.`
      : 'Tilecache container unavailable; tile caching is disabled.'
    if (isThirdPartyPmtilesEnabled(configPath)) {
      app.setPluginStatus(`${tcStatus} PMTiles charts disabled: signalk-pmtiles-plugin is enabled, disable it to use the companion chart provider.`)
    } else {
      app.setPluginStatus(tcStatus)
    }
  }

  async function doStop (): Promise<void> {
    if (positionUnsub) { positionUnsub(); positionUnsub = null }
    warmer = null
    teardownCharts()

    // Clear the tilecache address first so the proxy routes report unavailable, then stop its container.
    tilecacheAddress = null
    if (tilecacheLaunched) {
      const manager = getContainerManager()
      if (manager) {
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
        const dataDir = (app as unknown as { getDataDirPath: () => string }).getDataDirPath()
        const { bsize, bavail } = statfsSync(dataDir)
        const freeGiB = Math.floor((bsize * bavail) / (1024 ** 3))
        capDefaultGiB = Math.max(1, Math.floor(freeGiB * 0.8))
      } catch {
        // Detection failed (early call or a platform without statfs): keep the conservative default.
      }
      return {
        type: 'object',
        properties: {
          tilecacheImageTag: {
            type: 'string',
            title: 'Tile cache container image tag',
            description: 'The image tag to run for the tile cache and proxy container.',
            default: DEFAULT_TILECACHE_TAG
          },
          tilecacheCacheCapGiB: {
            type: 'integer',
            multipleOf: 1,
            minimum: 1,
            maximum: 1024,
            title: 'Tile cache size cap (GiB)',
            description: 'The most disk space the on-disk tile cache may use. When the cache reaches this size it evicts the least recently used unpinned tiles to stay under the cap. The default is about 80 percent of the free space detected on the Signal K data directory when this form loaded, which leaves roughly 20 percent headroom. Do not set this to all of your free space: the cache grows to fill the cap, and a full disk can stop the server from writing. If you point the cache at an external drive in the field below, this value reflects the data directory filesystem, not the drive, so set the cap manually to suit the drive.',
            default: capDefaultGiB
          },
          tilecacheRegionsBudgetGiB: {
            type: 'integer',
            multipleOf: 1,
            minimum: 0,
            title: 'Saved-regions reserved budget (GiB)',
            description: 'A ceiling on how much disk space saved regions may pin. Leave 0 to reserve half the cache cap. This is not space taken from the scroll cache until a region is actually saved. A value above the cache cap is clamped to the cap.',
            default: 0
          },
          tilecacheCacheVolumeSource: {
            type: 'string',
            title: 'External tile cache drive (optional)',
            description: 'Host path of a USB SSD or NVMe drive to hold the tile cache. Leave blank to keep the cache on the Signal K data directory.',
            default: ''
          },
          chartsPath: {
            type: 'string',
            title: 'PMTiles charts directory',
            description: 'Directory holding .pmtiles charts, relative to the Signal K config path. Leave blank for the default charts/pmtiles.',
            default: ''
          }
        }
      }
    },
    uiSchema: {
      tilecacheCacheCapGiB: { 'ui:widget': 'range' },
      tilecacheRegionsBudgetGiB: { 'ui:widget': 'updown' }
    },
    // Signal K calls start synchronously and does not await it, so the async work runs detached with
    // an explicit catch: a doStart rejection surfaces as a plugin error instead of an unhandled
    // rejection. Chaining onto the shared lifecycle promise serializes this start after any in-flight
    // stop, so a stop() queued before this start() always completes before doStart runs.
    start (config: CompanionConfig) {
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
    // Mount the tile and style proxy on the Signal K server so every device reaches the cached tiles
    // through the server, keeping the container plugin-only. The routes read the live tilecache address.
    // The regions routes are admin-gated (fail closed if the security strategy is absent); the tile
    // routes remain open so every device can fetch cached tiles without authentication. Additional
    // route groups (PMTiles serve and management, v3) compose by mounting alongside these two.
    registerWithRouter (router) {
      registerTileRoutes(router as unknown as TileRouter, () => tilecacheAddress, undefined, `/plugins/${PLUGIN_ID}`)
      registerRegionsRoutes(router as unknown as RegionsRouter, app, () => tilecacheAddress)
      registerPmtilesServeRoute(router as unknown as ServeRouter, registry)
      if (ensureApiAdminGate(app)) {
        registerChartManagementRoutes(
          router as unknown as ManagementRouter,
          registry,
          getOverrides(),
          () => {
            if (rescanInProgress) return
            rescanInProgress = true
            ;(async () => {
              const { rescanCharts } = await import('../charts/discovery.js')
              await rescanCharts({ chartsDir: activeChartsDir ?? chartsDirFor({}), registry, namer: getOverrides().namer() })
            })()
              .catch((err: unknown) => app.debug(`chart rescan after override failed: ${String(err)}`))
              .finally(() => { rescanInProgress = false })
          }
        )
      }
    }
  }
}
