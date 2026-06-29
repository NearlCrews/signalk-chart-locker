/** The plugin factory: lifecycle that launches the tilecache container and registers chart providers. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { Position } from '../shared/types.js'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION } from '../shared/plugin-id.js'
import { requireContainerManager, getContainerManager, ensureRuntimeReady } from '../runtime/container-manager.js'
import { TILECACHE_CONTAINER_NAME, TILECACHE_INTERNAL_PORT, DEFAULT_TILECACHE_TAG, buildTilecacheConfig, probeTilecacheHealth } from '../runtime/tilecache-container.js'
import { buildSourcePayload, pushTilecacheConfig } from '../runtime/tilecache-config-push.js'
import { registerTileRoutes, type TileRouter } from '../http/tile-routes.js'
import { registerPrewarmRoutes, type PrewarmRouter } from '../http/prewarm-routes.js'
import { ChartRegistry, registerChartProvider, type ChartRouteApp } from '../charts/chart-registry.js'
import { type DiscoveryHandle, startDiscovery } from '../charts/discovery.js'
import { isThirdPartyPmtilesEnabled } from '../charts/mutual-exclusion.js'
import { registerPmtilesServeRoute, type ServeRouter } from '../http/pmtiles-routes.js'
import { registerChartManagementRoutes, type ManagementRouter } from '../http/chart-management-routes.js'
import { OverrideStore } from '../charts/overrides.js'
import { ensureApiAdminGate } from '../shared/admin-gate.js'
import { join, resolve } from 'node:path'
import { createPositionWarmer, type PositionWarmer } from '../runtime/position-warmer.js'
import { loadPrewarmStore, POSITION_WARM_REGION_ID } from '../runtime/prewarm-store.js'
import { warmRegion } from '../runtime/tilecache-client.js'

interface CompanionConfig {
  tilecacheImageTag?: string
  tilecacheCacheCapBytes?: number
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
      const tilecacheConfig = buildTilecacheConfig({
        tag: config?.tilecacheImageTag?.trim() || undefined,
        ...(typeof config?.tilecacheCacheCapBytes === 'number' ? { capBytes: config.tilecacheCacheCapBytes } : {}),
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
        const pushed = await pushTilecacheConfig(tcAddress, buildSourcePayload())
        if (!pushed) {
          app.debug('Tilecache config push failed; the proxy has an empty allowlist until the next push.')
        }
      }
    } catch (err) {
      app.debug('Tilecache container did not start; tile caching is disabled:', err)
    }

    loadPrewarmStore(app.getDataDirPath())
    warmer = createPositionWarmer({
      getStore: () => loadPrewarmStore(app.getDataDirPath()),
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
    schema: () => ({
      type: 'object',
      properties: {
        tilecacheImageTag: {
          type: 'string',
          title: 'Tile cache container image tag',
          description: 'The image tag to run for the tile cache and proxy container.',
          default: DEFAULT_TILECACHE_TAG
        },
        tilecacheCacheCapBytes: {
          type: 'number',
          title: 'Tile cache size cap, in bytes',
          description: 'The maximum disk the tile cache uses before evicting the least recently used tiles. Default 2 GiB; keep it conservative on a microSD card.',
          default: 2147483648
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
    }),
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
    // The prewarm routes are admin-gated (fail closed if the security strategy is absent); the tile
    // routes remain open so every device can fetch cached tiles without authentication. Additional
    // route groups (PMTiles serve and management, v3) compose by mounting alongside these two.
    registerWithRouter (router) {
      registerTileRoutes(router as unknown as TileRouter, () => tilecacheAddress)
      registerPrewarmRoutes(router as unknown as PrewarmRouter, app, () => tilecacheAddress)
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
