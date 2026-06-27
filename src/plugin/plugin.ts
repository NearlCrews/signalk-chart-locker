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
    async start (config: CompanionConfig) {
      const manager = requireContainerManager(app)
      if (!manager) return
      if (!(await ensureRuntimeReady(app, manager))) return

      const address = await startRouterContainer(manager, { tag: config?.imageTag })
      installRouteOnWaterBridge(createSkeletonBridge(address, probeRouterHealth))
      started = true
      app.setPluginStatus(`Router container running and reachable at ${address}.`)
    },
    async stop () {
      if (!started) return
      removeRouteOnWaterBridge()
      // Defensive: the signalk-container manager could have become unavailable between start and stop
      // (for example, if the user disabled signalk-container while the companion was running).
      const manager = getContainerManager()
      if (manager) await manager.stop(ROUTER_CONTAINER_NAME)
      started = false
    }
  }
}
