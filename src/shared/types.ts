/** Cross-module types: the container manager surface this plugin consumes, and the route-on-water bridge contract. */

export interface Position {
  latitude: number
  longitude: number
}

/** The minimal fetch Response surface this plugin reads: an ok flag and a JSON body parser. */
export interface FetchResponse {
  ok: boolean
  json(): Promise<unknown>
}

export interface ContainerRuntimeInfo {
  runtime: string
  version?: string
}

export interface ContainerHealthcheck {
  test: string[]
  interval?: string
  timeout?: string
  startPeriod?: string
  retries?: number
}

export interface ContainerResourceLimits {
  memory?: string
  memorySwap?: string
  cpus?: number
  pidsLimit?: number
  oomScoreAdj?: number
}

/** A bind or named volume with an optional missing-source policy, mirroring signalk-container's VolumeSpec. */
export interface ContainerVolumeSpec {
  source: string
  ifMissing?: 'create' | 'skip' | 'abort'
}

export interface ContainerConfig {
  image: string
  tag?: string
  signalkAccessiblePorts?: number[]
  healthcheck?: ContainerHealthcheck
  resources?: ContainerResourceLimits
  restart?: string
  env?: Record<string, string>
  /** Container mount path keyed to a host path, a named volume, or a VolumeSpec, passed through to signalk-container. */
  volumes?: Record<string, string | ContainerVolumeSpec>
  /** Container path at which signalk-container mounts the Signal K data directory (the zero-config durable mount). */
  signalkDataMount?: string
  /** In-image uid and gid for a non-root image, or false to opt out of host-UID alignment. */
  user?: { inImageUid?: number, inImageGid?: number } | false
}

/** Options forwarded to the manager's ensureRunning, so the container is attributed to this plugin in the signalk-container manifest and UI. */
export interface EnsureRunningOptions {
  pluginId?: string
  pluginVersion?: string
}

/** The subset of the signalk-container manager API this plugin uses. */
export interface ContainerManager {
  whenReady(): Promise<void>
  getRuntime(): ContainerRuntimeInfo | null
  ensureRunning(name: string, config: ContainerConfig, options?: EnsureRunningOptions): Promise<void>
  resolveContainerAddress(name: string, port: number): Promise<string | null>
  stop(name: string): Promise<void>
}

export type RouteOnWaterResult =
  | { ok: true; waypoints: Position[]; usedTileWater: boolean; borderFallback: boolean }
  | { ok: false; reason: string }

/** Installed on globalThis for in-process callers (crows-nest) to reach the router. */
export interface RouteOnWaterBridge {
  whenReady(): Promise<void>
  routeOnWater(request: unknown): Promise<RouteOnWaterResult>
}
