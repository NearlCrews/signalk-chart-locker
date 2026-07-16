/** Resolves the signalk-container manager from the global it publishes, and guards on a detected runtime. */

import type { ServerAPI } from '@signalk/server-api'
import type { ContainerManager } from '../shared/types.js'

/** The global key signalk-container publishes its manager on, mirrored by BRIDGE_GLOBAL_KEY for the bridge. */
export const CONTAINER_MANAGER_GLOBAL_KEY = '__signalk_containerManager'
export const CONTAINER_READY_TIMEOUT_MS = 30_000

type ReadinessOutcome = 'ready' | 'timeout' | 'aborted' | { error: unknown }

async function waitForReadiness (operation: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<ReadinessOutcome> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (outcome: ReadinessOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => { finish('aborted') }
    const timer = setTimeout(() => { finish('timeout') }, timeoutMs)
    if (signal?.aborted === true) {
      finish('aborted')
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    operation.then(
      () => { finish('ready') },
      (error: unknown) => { finish({ error }) }
    )
  })
}

export function getContainerManager (): ContainerManager | null {
  const manager = (globalThis as Record<string, unknown>)[CONTAINER_MANAGER_GLOBAL_KEY] as ContainerManager | undefined
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

export async function ensureRuntimeReady (
  app: ServerAPI,
  manager: ContainerManager,
  options: { timeoutMs?: number, signal?: AbortSignal } = {}
): Promise<boolean> {
  let operation: Promise<void>
  try {
    operation = manager.whenReady()
  } catch (error) {
    app.setPluginError(`The signalk-container plugin readiness check failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  const outcome = await waitForReadiness(operation, options.timeoutMs ?? CONTAINER_READY_TIMEOUT_MS, options.signal)
  if (outcome === 'aborted') return false
  if (outcome === 'timeout') {
    app.setPluginError('The signalk-container plugin did not become ready before the startup timeout.')
    return false
  }
  if (typeof outcome === 'object') {
    app.setPluginError(`The signalk-container plugin readiness check failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`)
    return false
  }
  let runtime: ReturnType<ContainerManager['getRuntime']>
  try {
    runtime = manager.getRuntime()
  } catch (error) {
    app.setPluginError(`The signalk-container runtime check failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (!runtime) {
    app.setPluginError('No container runtime was detected. Install Docker or Podman and configure signalk-container.')
    return false
  }
  return true
}
