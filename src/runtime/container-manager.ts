/** Resolves the signalk-container manager from the global it publishes, and guards on a detected runtime. */

import type { ContainerManager } from '../shared/types.js'
import { errorMessage } from '../shared/error.js'

/**
 * The only surface these helpers need from the server. Narrowed from ServerAPI so a caller can route
 * the diagnosis somewhere else as well as to the server: setPluginStatus and setPluginError write the
 * same status slot, so the plugin has to keep an actionable error and re-state it, which it cannot do
 * when the message never leaves this module.
 */
export interface PluginErrorReporter {
  setPluginError: (message: string) => void
}

/** The global key signalk-container publishes its manager on. */
export const CONTAINER_MANAGER_GLOBAL_KEY = '__signalk_containerManager'
const CONTAINER_READY_TIMEOUT_MS = 30_000

export type ManagerOperationOutcome<T> =
  | { status: 'completed', value: T }
  | { status: 'rejected', error: unknown }
  | { status: 'timeout' }
  | { status: 'aborted' }

/** Bound an otherwise uninterruptible manager promise while retaining its eventual completion. None
 * of the manager calls takes a signal, so this is the one place a caller's timeout and abort apply. */
export async function waitForManagerOperation<T> (
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ManagerOperationOutcome<T>> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (outcome: ManagerOperationOutcome<T>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => { finish({ status: 'aborted' }) }
    const timer = setTimeout(() => { finish({ status: 'timeout' }) }, timeoutMs)
    if (signal?.aborted === true) {
      finish({ status: 'aborted' })
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => { finish({ status: 'completed', value }) },
      (error: unknown) => { finish({ status: 'rejected', error }) }
    )
  })
}

export function getContainerManager (): ContainerManager | null {
  const manager = (globalThis as Record<string, unknown>)[CONTAINER_MANAGER_GLOBAL_KEY] as ContainerManager | undefined
  return manager ?? null
}

export function requireContainerManager (app: PluginErrorReporter): ContainerManager | null {
  const manager = getContainerManager()
  if (!manager) {
    app.setPluginError('The signalk-container plugin is required but was not found. Install and enable it.')
    return null
  }
  return manager
}

export async function ensureRuntimeReady (
  app: PluginErrorReporter,
  manager: ContainerManager,
  options: { timeoutMs?: number, signal?: AbortSignal } = {}
): Promise<boolean> {
  let operation: Promise<void>
  try {
    operation = manager.whenReady()
  } catch (error) {
    app.setPluginError(`The signalk-container plugin readiness check failed: ${errorMessage(error)}`)
    return false
  }
  const outcome = await waitForManagerOperation(operation, options.timeoutMs ?? CONTAINER_READY_TIMEOUT_MS, options.signal)
  if (outcome.status === 'aborted') return false
  if (outcome.status === 'timeout') {
    app.setPluginError('The signalk-container plugin did not become ready before the startup timeout.')
    return false
  }
  if (outcome.status === 'rejected') {
    app.setPluginError(`The signalk-container plugin readiness check failed: ${errorMessage(outcome.error)}`)
    return false
  }
  let runtime: ReturnType<ContainerManager['getRuntime']>
  try {
    runtime = manager.getRuntime()
  } catch (error) {
    app.setPluginError(`The signalk-container runtime check failed: ${errorMessage(error)}`)
    return false
  }
  if (!runtime) {
    app.setPluginError('No container runtime was detected. Install Docker or Podman and configure signalk-container.')
    return false
  }
  return true
}
