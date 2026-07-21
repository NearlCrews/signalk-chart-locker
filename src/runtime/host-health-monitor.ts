/** Periodically verifies the host-side container endpoint and repairs a wedged port forward. */

export const HOST_HEALTH_INTERVAL_MS = 30_000
export const HOST_HEALTH_FAILURE_THRESHOLD = 3
export const HOST_HEALTH_RECOVERY_COOLDOWN_MS = 5 * 60_000

export type HostHealthState =
  | { status: 'healthy' }
  | { status: 'host-unreachable', failureCount: number, failureThreshold: number }
  | { status: 'restarting' }
  | { status: 'restoring' }
  | { status: 'container-unhealthy' }
  | { status: 'recovered' }
  | { status: 'recovery-failed', error: string }

export interface HostProbeResult {
  healthy: boolean
  configured?: boolean
}

export interface HostHealthMonitorOptions {
  getAddress: () => string | null
  probeHost: (address: string, signal?: AbortSignal) => Promise<HostProbeResult>
  probeContainer: () => Promise<boolean>
  restart: () => Promise<string | null>
  restore: (address: string, signal?: AbortSignal) => Promise<void>
  restoreInitially?: boolean
  onAddress: (address: string | null) => void
  onState: (state: HostHealthState) => void
  onError?: (error: unknown) => void
  intervalMs?: number
  failureThreshold?: number
  recoveryCooldownMs?: number
  now?: () => number
}

export interface HostHealthMonitor {
  start: () => void
  checkNow: () => Promise<void>
  stop: () => Promise<void>
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createHostHealthMonitor (options: HostHealthMonitorOptions): HostHealthMonitor {
  const intervalMs = options.intervalMs ?? HOST_HEALTH_INTERVAL_MS
  const failureThreshold = options.failureThreshold ?? HOST_HEALTH_FAILURE_THRESHOLD
  const recoveryCooldownMs = options.recoveryCooldownMs ?? HOST_HEALTH_RECOVERY_COOLDOWN_MS
  const now = options.now ?? Date.now
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('host health interval must be positive')
  if (!Number.isInteger(failureThreshold) || failureThreshold <= 0) throw new Error('host health failure threshold must be a positive integer')
  if (!Number.isFinite(recoveryCooldownMs) || recoveryCooldownMs < 0) throw new Error('host health recovery cooldown must be nonnegative')

  let running = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let probeController: AbortController | null = null
  let consecutiveFailures = 0
  let nextRecoveryAt = 0
  let restorePendingAddress = options.restoreInitially === true ? options.getAddress() : null
  let recoveryPending = false
  let queued = Promise.resolve()

  const schedule = (): void => {
    if (!running || disposed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      checkNow().finally(schedule).catch((error: unknown) => { options.onError?.(error) })
    }, intervalMs)
    timer.unref?.()
  }

  const runCheck = async (): Promise<void> => {
    if (disposed) return
    const address = options.getAddress()
    if (address === null) return

    const controller = new AbortController()
    probeController = controller
    let hostStatus: HostProbeResult = { healthy: false }
    try {
      hostStatus = await options.probeHost(address, controller.signal)
    } catch (error) {
      options.onError?.(error)
    } finally {
      if (probeController === controller) probeController = null
    }
    if (disposed) return

    if (hostStatus.healthy) {
      if (hostStatus.configured === false) restorePendingAddress = address
      if (recoveryPending && restorePendingAddress === null) restorePendingAddress = address
      if (restorePendingAddress !== null) {
        if (now() < nextRecoveryAt) return
        nextRecoveryAt = now() + recoveryCooldownMs
        options.onState({ status: 'restoring' })
        const restoreController = new AbortController()
        probeController = restoreController
        try {
          await options.restore(address, restoreController.signal)
          if (disposed) return
          restorePendingAddress = null
          recoveryPending = false
          consecutiveFailures = 0
          nextRecoveryAt = 0
          options.onState({ status: 'recovered' })
        } catch (error) {
          if (disposed) return
          const message = errorMessage(error)
          options.onError?.(error)
          options.onState({ status: 'recovery-failed', error: message })
        } finally {
          if (probeController === restoreController) probeController = null
        }
        return
      }
      consecutiveFailures = 0
      nextRecoveryAt = 0
      options.onState({ status: 'healthy' })
      return
    }

    consecutiveFailures = Math.min(consecutiveFailures + 1, failureThreshold)
    if (consecutiveFailures < failureThreshold) {
      options.onState({ status: 'host-unreachable', failureCount: consecutiveFailures, failureThreshold })
      return
    }
    if (now() < nextRecoveryAt) return
    options.onState({ status: 'host-unreachable', failureCount: consecutiveFailures, failureThreshold })
    nextRecoveryAt = now() + recoveryCooldownMs

    if (!recoveryPending) {
      let containerHealthy = false
      try {
        containerHealthy = await options.probeContainer()
      } catch (error) {
        options.onError?.(error)
      }
      if (disposed) return
      if (!containerHealthy) {
        options.onState({ status: 'container-unhealthy' })
        return
      }
      recoveryPending = true
    }

    options.onState({ status: 'restarting' })
    try {
      const recoveredAddress = await options.restart()
      if (disposed) return
      options.onAddress(recoveredAddress)
      if (recoveredAddress === null) throw new Error('container address did not resolve after restart')
      restorePendingAddress = recoveredAddress
      const recoveryController = new AbortController()
      probeController = recoveryController
      let recovered = false
      try {
        recovered = (await options.probeHost(recoveredAddress, recoveryController.signal)).healthy
        if (recovered) {
          options.onState({ status: 'restoring' })
          await options.restore(recoveredAddress, recoveryController.signal)
        }
      } finally {
        if (probeController === recoveryController) probeController = null
      }
      if (disposed) return
      if (!recovered) throw new Error('host-side health probe still fails after restart')
      restorePendingAddress = null
      recoveryPending = false
      consecutiveFailures = 0
      nextRecoveryAt = 0
      options.onState({ status: 'recovered' })
    } catch (error) {
      if (disposed) return
      const message = errorMessage(error)
      options.onError?.(error)
      options.onState({ status: 'recovery-failed', error: message })
    }
  }

  const checkNow = async (): Promise<void> => {
    const check = queued.then(runCheck, runCheck)
    queued = check.catch(() => {})
    await check
  }

  return {
    start () {
      if (disposed || running) return
      running = true
      schedule()
    },
    checkNow,
    async stop () {
      if (disposed) return
      disposed = true
      running = false
      if (timer !== null) clearTimeout(timer)
      timer = null
      probeController?.abort()
      probeController = null
      await queued
    }
  }
}
