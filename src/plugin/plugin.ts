/** The plugin factory: lifecycle that launches the router container and publishes the in-process bridge. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION } from '../shared/plugin-id.js'
import { requireContainerManager, getContainerManager, ensureRuntimeReady } from '../runtime/container-manager.js'
import { ROUTER_CONTAINER_NAME, ROUTER_INTERNAL_PORT, DEFAULT_ROUTER_TAG, buildRouterConfig, probeRouterHealth } from '../runtime/router-container.js'
import { TILECACHE_CONTAINER_NAME, TILECACHE_INTERNAL_PORT, buildTilecacheConfig } from '../runtime/tilecache-container.js'
import { buildSourcePayload, pushTilecacheConfig } from '../runtime/tilecache-config-push.js'
import { installRouteOnWaterBridge, removeRouteOnWaterBridge, createRouterBridge } from '../bridge/route-on-water-bridge.js'
import { registerTileRoutes, type TileRouter } from '../http/tile-routes.js'

interface CompanionConfig {
  imageTag?: string
  tilecacheImageTag?: string
  tilecacheCacheCapBytes?: number
  tilecacheCacheVolumeSource?: string
}

export function createPlugin (app: ServerAPI): Plugin {
  // All lifecycle transitions are serialized through this chain. It always resolves: errors from
  // doStart are caught in start(), and doStop never throws. This eliminates the concurrent-call
  // race where stop() setting a flag could be undone by a subsequent start() resetting it.
  let lifecycle: Promise<void> = Promise.resolve()
  // launched: set to true the moment ensureRunning resolves, so doStop knows a container was
  // started even if address resolution or bridge installation never completed.
  let launched = false
  // The tilecache is secondary: routing is the critical path, tiles are a convenience, so a tilecache
  // failure never blocks the router or the bridge. Its address is held for the proxy routes.
  let tilecacheLaunched = false
  let tilecacheAddress: string | null = null

  async function doStart (config: CompanionConfig): Promise<void> {
    app.setPluginStatus('Starting...')
    const manager = requireContainerManager(app)
    if (!manager) return
    if (!(await ensureRuntimeReady(app, manager))) return

    // A blank or whitespace-only imageTag falls back to the default rather than producing an empty
    // tag, which would yield an invalid image reference with a trailing colon.
    const tag = config?.imageTag?.trim() || undefined
    await manager.ensureRunning(ROUTER_CONTAINER_NAME, buildRouterConfig({ tag }), { pluginId: PLUGIN_ID })
    launched = true

    const address = await manager.resolveContainerAddress(ROUTER_CONTAINER_NAME, ROUTER_INTERNAL_PORT)
    if (!address) {
      throw new Error('The router container address could not be resolved after ensureRunning.')
    }

    installRouteOnWaterBridge(createRouterBridge(address, probeRouterHealth))

    // The tilecache container is the one internet-egress container. It is non-fatal: a failure here
    // disables tile caching but leaves routing and the bridge fully working.
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
        await pushTilecacheConfig(tcAddress, buildSourcePayload())
      }
    } catch (err) {
      app.debug('Tilecache container did not start; tile caching is disabled:', err)
    }

    app.setPluginStatus(`Router at ${address}${tilecacheAddress !== null ? `, tilecache at ${tilecacheAddress}` : ''}.`)
  }

  async function doStop (): Promise<void> {
    removeRouteOnWaterBridge()

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

    // Only stop the container if it was actually launched. If the launch partially failed (address
    // resolution returned null) or no start has run yet, launched is false and we skip the stop.
    if (launched) {
      const manager = getContainerManager()
      if (manager) {
        try {
          await manager.stop(ROUTER_CONTAINER_NAME)
        } catch (err) {
          app.debug('Failed to stop router container:', err)
        }
      }
      launched = false
    }
  }

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    schema: () => ({
      type: 'object',
      properties: {
        imageTag: {
          type: 'string',
          title: 'Router container image tag',
          description: 'The image tag to run for the router container.',
          default: DEFAULT_ROUTER_TAG
        },
        tilecacheImageTag: {
          type: 'string',
          title: 'Tile cache container image tag',
          description: 'The image tag to run for the tile cache and proxy container.',
          default: DEFAULT_ROUTER_TAG
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
    registerWithRouter (router) {
      registerTileRoutes(router as unknown as TileRouter, () => tilecacheAddress)
    }
  }
}
