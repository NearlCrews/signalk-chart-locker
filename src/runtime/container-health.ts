/** Shared container health probe and healthcheck builder, used by every managed container so the two cannot drift. */

import type { ContainerConfig } from '../shared/types.js'
import { containerFetchSignal } from './container-fetch.js'
import { readBoundedResponseJson } from './bounded-response.js'

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

/** Probe a managed container's /health endpoint; true only on a 200 whose body is {status:'ok'}. The
 *  default probe bounds itself with a timeout so a deadlocked container cannot hang the probe. */
export async function probeContainerHealth (address: string, fetchFn: FetchLike = fetch, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetchFn(`http://${address}/health`, { signal: containerFetchSignal(signal) })
    if (!response.ok) return false
    const body = (await readBoundedResponseJson(response)) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}

/** The exec-form healthcheck for a distroless container (no shell): the binary checks its own liveness. */
export function makeContainerHealthcheck (binary: string): NonNullable<ContainerConfig['healthcheck']> {
  return { test: ['CMD', binary, 'healthcheck'], interval: '30s', timeout: '5s', startPeriod: '15s', retries: 3 }
}
