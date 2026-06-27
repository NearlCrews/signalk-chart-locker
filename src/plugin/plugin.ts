/** The plugin factory: lifecycle that launches the router container and publishes the in-process bridge. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION } from '../shared/plugin-id.js'
import { requireContainerManager, getContainerManager, ensureRuntimeReady } from '../runtime/container-manager.js'
import { ROUTER_CONTAINER_NAME, ROUTER_INTERNAL_PORT, buildRouterConfig, probeRouterHealth } from '../runtime/router-container.js'
import { installRouteOnWaterBridge, removeRouteOnWaterBridge, createSkeletonBridge } from '../bridge/route-on-water-bridge.js'

interface CompanionConfig {
  imageTag?: string
}

export function createPlugin (app: ServerAPI): Plugin {
  // launched: set to true the moment ensureRunning resolves, so stop() knows a container was started
  // even if address resolution or bridge installation never completed.
  let launched = false
  // stopRequested: set by stop() so an in-flight start can detect a concurrent stop and tear down.
  let stopRequested = false
  // startPromise: the in-flight start chain (with its error catch), awaited by stop() to drain it safely.
  let startPromise: Promise<void> | null = null

  async function startCompanion (config: CompanionConfig): Promise<void> {
    const manager = requireContainerManager(app)
    if (!manager) return
    if (!(await ensureRuntimeReady(app, manager))) return

    const tag = config?.imageTag
    await manager.ensureRunning(ROUTER_CONTAINER_NAME, buildRouterConfig({ tag }), { pluginId: PLUGIN_ID })
    launched = true

    const address = await manager.resolveContainerAddress(ROUTER_CONTAINER_NAME, ROUTER_INTERNAL_PORT)
    if (!address) {
      throw new Error('The router container address could not be resolved after ensureRunning.')
    }

    // A stop() arrived while we were resolving the address. Tear down the container we launched and
    // bail out without installing the bridge, so no orphan is left behind.
    if (stopRequested) {
      const m = getContainerManager()
      if (m) {
        try {
          await m.stop(ROUTER_CONTAINER_NAME)
        } catch (err) {
          app.debug('Failed to stop container after stop-during-launch race:', err)
        }
      }
      launched = false
      return
    }

    installRouteOnWaterBridge(createSkeletonBridge(address, probeRouterHealth))
    app.setPluginStatus(`Router container running and reachable at ${address}.`)
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
          default: 'latest'
        }
      }
    }),
    // Signal K calls start synchronously and does not await it, so the async work runs detached with an
    // explicit catch: a container-launch rejection surfaces as a plugin error instead of an unhandled rejection.
    // The caught promise is stored so stop() can await it and drain the in-flight launch safely.
    start (config: CompanionConfig) {
      startPromise = startCompanion(config).catch((err: unknown) => {
        app.setPluginError(`Startup failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      return startPromise
    },
    async stop () {
      stopRequested = true

      // Drain the in-flight start before proceeding. The promise always resolves (errors are caught
      // inside startCompanion's .catch handler), so this never throws here.
      if (startPromise !== null) {
        try { await startPromise } catch { /* already surfaced as a plugin error */ }
        startPromise = null
      }

      removeRouteOnWaterBridge()

      // Only stop the container if it was actually launched. If the launch partially failed (address
      // resolution returned null) or a concurrent stop already handled teardown, launched is false.
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
  }
}
