/** Resolves the signalk-container manager from the global it publishes, and guards on a detected runtime. */

import type { ServerAPI } from '@signalk/server-api'
import type { ContainerManager } from '../shared/types.js'

export function getContainerManager (): ContainerManager | null {
  const manager = (globalThis as { __signalk_containerManager?: ContainerManager }).__signalk_containerManager
  return manager ?? null
}

export function requireContainerManager (app: ServerAPI): ContainerManager | null {
  const manager = getContainerManager()
  if (!manager) {
    app.setPluginError('The signalk-container plugin is required but was not found. Install and enable it.')
    return null
  }
  return manager
}

export async function ensureRuntimeReady (app: ServerAPI, manager: ContainerManager): Promise<boolean> {
  await manager.whenReady()
  if (!manager.getRuntime()) {
    app.setPluginError('No container runtime was detected. Install Docker or Podman and configure signalk-container.')
    return false
  }
  return true
}
