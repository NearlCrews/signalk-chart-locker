/** The plugin factory: lifecycle that launches the router container and publishes the in-process bridge. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION } from '../shared/plugin-id.js'
import { requireContainerManager, getContainerManager, ensureRuntimeReady } from '../runtime/container-manager.js'
import { ROUTER_CONTAINER_NAME, startRouterContainer, probeRouterHealth } from '../runtime/router-container.js'
import { installRouteOnWaterBridge, removeRouteOnWaterBridge, createSkeletonBridge } from '../bridge/route-on-water-bridge.js'

interface CompanionConfig {
  imageTag?: string
}

export function createPlugin (app: ServerAPI): Plugin {
  let started = false

  async function startCompanion (config: CompanionConfig): Promise<void> {
    const manager = requireContainerManager(app)
    if (!manager) return
    if (!(await ensureRuntimeReady(app, manager))) return

    const address = await startRouterContainer(manager, { tag: config?.imageTag, pluginId: PLUGIN_ID })
    installRouteOnWaterBridge(createSkeletonBridge(address, probeRouterHealth))
    started = true
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
    // The caught promise is returned so callers that do await (tests) can observe completion; the server ignores it.
    start (config: CompanionConfig) {
      return startCompanion(config).catch((err: unknown) => {
        app.setPluginError(`Startup failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
    async stop () {
      if (!started) return
      removeRouteOnWaterBridge()
      // Defensive: the signalk-container manager could have become unavailable between start and stop
      // (for example, if the user disabled signalk-container while the companion was running).
      const manager = getContainerManager()
      if (manager) {
        try {
          await manager.stop(ROUTER_CONTAINER_NAME)
        } catch {
          // The container may already be stopped or removed; stop is best-effort.
        }
      }
      started = false
    }
  }
}
