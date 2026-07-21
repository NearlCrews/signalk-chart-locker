/** Cross-module types: the container manager surface this plugin consumes. */

export interface Position {
  latitude: number
  longitude: number
}

export interface ContainerRuntimeInfo {
  runtime: string
  version?: string
}

interface ContainerHealthcheck {
  test: string[]
  interval?: string
  timeout?: string
  startPeriod?: string
  retries?: number
}

interface ContainerResourceLimits {
  memory?: string
  memorySwap?: string
  cpus?: number
  pidsLimit?: number
  oomScoreAdj?: number
}

/** A bind or named volume with an optional missing-source policy, mirroring signalk-container's VolumeSpec. */
interface ContainerVolumeSpec {
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
interface EnsureRunningOptions {
  pluginId?: string
  pluginVersion?: string
  onVolumeIssue?: (event: {
    containerPath: string
    source: string
    action: 'skipped' | 'aborted' | 'recovered'
    reason: string
  }) => void | Promise<void>
}

/** Opaque version-source handle from the manager's update-source factories; consumers never implement it. */
export interface ContainerVersionSource {
  /** Payload deliberately opaque: this plugin never calls fetch. */
  fetch(runtime: ContainerRuntimeInfo): Promise<unknown>
}

/** One registration with signalk-container's centralized update service (the "up to date" / "Check now" UI). */
export interface ContainerUpdateRegistration {
  pluginId: string
  containerName: string
  /** Image repo without tag, for example "ghcr.io/nearlcrews/signalk-chart-locker-tilecache". */
  image: string
  /** Must be a function so live config edits are picked up without re-registering. */
  currentTag: () => string
  versionSource: ContainerVersionSource
}

/** The subset of the manager's update service this plugin uses. */
export interface ContainerUpdateService {
  register(reg: ContainerUpdateRegistration): void
  unregister(pluginId: string): void
  /** Payload deliberately opaque: fired detached, result never read. */
  checkOne(pluginId: string): Promise<unknown>
  sources: {
    githubReleases(repo: string, options?: { allowPrerelease?: boolean, tagPrefix?: string }): ContainerVersionSource
  }
}

/** The subset of the signalk-container manager API this plugin uses. */
export interface ContainerManager {
  whenReady(): Promise<void>
  getRuntime(): ContainerRuntimeInfo | null
  ensureRunning(name: string, config: ContainerConfig, options?: EnsureRunningOptions): Promise<void>
  recreate(name: string, config: ContainerConfig, options?: EnsureRunningOptions): Promise<void>
  resolveContainerAddress(name: string, port: number): Promise<string | null>
  stop(name: string): Promise<void>
  execInContainer(name: string, command: string[]): Promise<{ exitCode: number, stdout: string, stderr: string }>
  /** The centralized update service; optional because older signalk-container versions predate it. */
  updates?: ContainerUpdateService
}
