/** Shared container health probe and healthcheck builder, used by every managed container so the two cannot drift. */

import type { ContainerConfig, FetchResponse } from '../shared/types.js'

export type FetchLike = (url: string) => Promise<FetchResponse>

/** Probe a managed container's /health endpoint; true only on a 200 whose body is {status:'ok'}. */
export async function probeContainerHealth (address: string, fetchFn: FetchLike = (url: string) => fetch(url)): Promise<boolean> {
  try {
    const response = await fetchFn(`http://${address}/health`)
    if (!response.ok) return false
    const body = (await response.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}

/** The exec-form healthcheck for a distroless container (no shell): the binary checks its own liveness. */
export function makeContainerHealthcheck (binary: string): NonNullable<ContainerConfig['healthcheck']> {
  return { test: ['CMD', binary, 'healthcheck'], interval: '30s', timeout: '5s', startPeriod: '15s', retries: 3 }
}
