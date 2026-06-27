/** The plugin factory: lifecycle that launches the router container and publishes the in-process bridge. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION } from '../shared/plugin-id.js'
import { requireContainerManager, getContainerManager, ensureRuntimeReady } from '../runtime/container-manager.js'
import { ROUTER_CONTAINER_NAME, ROUTER_INTERNAL_PORT, buildRouterConfig, probeRouterHealth } from '../runtime/router-container.js'
import { installRouteOnWaterBridge, removeRouteOnWaterBridge, createRouterBridge } from '../bridge/route-on-water-bridge.js'

interface CompanionConfig {
  imageTag?: string
}

export function createPlugin (app: ServerAPI): Plugin {
  // All lifecycle transitions are serialized through this chain. It always resolves: errors from
  // doStart are caught in start(), and doStop never throws. This eliminates the concurrent-call
  // race where stop() setting a flag could be undone by a subsequent start() resetting it.
  let lifecycle: Promise<void> = Promise.resolve()
  // launched: set to true the moment ensureRunning resolves, so doStop knows a container was
  // started even if address resolution or bridge installation never completed.
  let launched = false

  async function doStart (config: CompanionConfig): Promise<void> {
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

    installRouteOnWaterBridge(createRouterBridge(address, probeRouterHealth))
    app.setPluginStatus(`Router container running and reachable at ${address}.`)
  }

  async function doStop (): Promise<void> {
    removeRouteOnWaterBridge()

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
          default: 'latest'
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
    }
  }
}
