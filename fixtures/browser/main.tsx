import * as React from 'react'
import { createRoot } from 'react-dom/client'

declare const __REMOTE_URL__: string

interface PanelProps {
  configuration: Record<string, unknown>
  save: (configuration: Record<string, unknown>) => void
}

interface RemoteContainer {
  get: (module: string) => Promise<() => { default: React.ComponentType<PanelProps> }>
  init: (scope: ShareScope) => Promise<void> | void
}

interface ShareScope {
  readonly react: Record<string, {
    readonly eager: boolean
    readonly from: string
    readonly get: () => Promise<() => typeof React>
    readonly loaded: boolean
    readonly shareConfig: {
      readonly requiredVersion: string
      readonly singleton: boolean
    }
  }>
}

const parameters = new URLSearchParams(window.location.search)
const ACTION_DELAY_MS = 500
if (parameters.has('unsupported-css-scope')) {
  Object.defineProperty(window, 'CSSScopeRule', {
    configurable: true,
    value: undefined
  })
}

const cacheStats = {
  rows: 2480,
  bytes: 700 * 1024 ** 2,
  cap: 8 * 1024 ** 3,
  pinnedBytes: 300 * 1024 ** 2,
  scrollBytes: 400 * 1024 ** 2,
  regionsBudgetBytes: 4 * 1024 ** 3,
  regionsFreeBytes: 3.7 * 1024 ** 3,
  positionWarmBytes: 0,
  availableBytes: 41.5 * 1024 ** 3,
  minimumHeadroomBytes: 256 * 1024 ** 2,
  diskPressure: false,
  configured: true,
  ttlDays: 30,
  bySource: [
    { source: 'openstreetmap', bytes: 300 * 1024 ** 2, rows: 1800 },
    { source: 'noaa', bytes: 100 * 1024 ** 2, rows: 680 }
  ],
  upstream: {
    openstreetmap: { slow: false, timeoutSecs: 15, lastTimeoutAt: 0 },
    noaa: { slow: false, timeoutSecs: 15, lastTimeoutAt: 0 }
  },
  diagnostics: {
    diskPressureEvents: 0,
    warmRejections: 0,
    configPushes: 1,
    cacheOperationErrors: 0
  }
}

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
})

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}

const actionReleases = new Map<string, () => void>()
const actionsToHold = new Set<string>()
Reflect.set(window, 'holdFixtureAction', (action: string): void => {
  actionsToHold.add(action)
})
Reflect.set(window, 'releaseFixtureAction', (action: string): void => {
  const release = actionReleases.get(action)
  if (release === undefined) throw new Error(`Fixture action is not pending: ${action}`)
  actionReleases.delete(action)
  release()
})

const waitForActionRelease = async (
  action: string,
  hold = parameters.has('hold-actions')
): Promise<void> => {
  if (!hold) {
    await delay(ACTION_DELAY_MS)
    return
  }

  document.body.dataset.fixturePendingAction = action
  await new Promise<void>((resolve) => actionReleases.set(action, resolve))
  delete document.body.dataset.fixturePendingAction
}

const incrementDatasetCount = (name: keyof DOMStringMap): number => {
  const next = Number(document.body.dataset[name] ?? 0) + 1
  document.body.dataset[name] = String(next)
  return next
}

window.fetch = async (input, init): Promise<Response> => {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(rawUrl, window.location.origin)
  const path = url.pathname

  if (path === '/plugins') {
    return jsonResponse([{
      id: 'signalk-chart-locker',
      data: { enabled: true },
      statusMessage: 'Tilecache at 127.0.0.1:8080; ready.'
    }])
  }
  if (path.endsWith('/api/cache-info')) {
    if (parameters.has('fail-cache-info')) return jsonResponse({ error: 'fixture failure' }, 503)
    return jsonResponse({
      freeGiB: 41.5,
      recommendedCapGiB: 32,
      storage: 'external',
      usingFallback: false
    })
  }
  if (path.endsWith('/api/cache/stats')) {
    const requestCount = incrementDatasetCount('cacheStatsRequestCount')
    await waitForActionRelease('refresh', actionsToHold.delete('refresh'))
    if (parameters.has('fail-cache-stats') || (parameters.has('fail-cache-refresh') && requestCount > 1)) {
      return jsonResponse({ error: 'fixture failure' }, 503)
    }
    return jsonResponse(cacheStats)
  }
  if (path.endsWith('/api/cache/config') && init?.method === 'POST') {
    incrementDatasetCount('retentionRequestCount')
    await waitForActionRelease('retention')
    if (parameters.has('fail-retention')) return jsonResponse({ error: 'fixture failure' }, 503)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as { ttlDays?: unknown } : {}
    if (typeof body.ttlDays === 'number') cacheStats.ttlDays = body.ttlDays
    return jsonResponse({ ok: true })
  }
  if (path.endsWith('/api/cache/clear-scroll') && init?.method === 'POST') {
    incrementDatasetCount('clearRequestCount')
    await delay(ACTION_DELAY_MS)
    return jsonResponse({ ok: true })
  }
  if (path.endsWith('/api/charts')) {
    return jsonResponse({
      charts: [{ id: 'local-one' }, { id: 'local-two' }],
      invalid: [],
      discovery: { lastScanAt: 1783953000000 }
    })
  }
  if (path.endsWith('/api/charts/rescan') && init?.method === 'POST') {
    incrementDatasetCount('rescanRequestCount')
    await waitForActionRelease('rescan')
    if (parameters.has('fail-rescan')) return jsonResponse({ error: 'fixture failure' }, 503)
    return jsonResponse({ ok: true })
  }
  return jsonResponse({ ok: false, error: `Unhandled fixture request: ${path}` }, 404)
}

const shareScope: ShareScope = {
  react: {
    [React.version]: {
      eager: true,
      from: 'chart-locker-browser-fixture',
      get: () => Promise.resolve(() => React),
      loaded: true,
      shareConfig: {
        requiredVersion: `^${React.version}`,
        singleton: true
      }
    }
  }
}

async function loadRemoteContainer (): Promise<RemoteContainer> {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = __REMOTE_URL__
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('Panel remote failed to load.')), { once: true })
    document.head.append(script)
  })
  const container = Reflect.get(window, 'signalk_chart_locker') as RemoteContainer | undefined
  if (container === undefined) throw new Error('Panel remote did not expose its global container.')
  return container
}

try {
  const container = await loadRemoteContainer()
  await container.init(shareScope)
  const factory = await container.get('./PluginConfigurationPanel')
  const Panel = factory().default
  const rootElement = document.querySelector('#root')
  if (!(rootElement instanceof HTMLElement)) throw new Error('Fixture root is missing.')

  const initialConfiguration = {
    tileCache: { cacheCapGiB: 8, regionsBudgetGiB: 4 },
    charts: { path: 'charts/pmtiles' },
    advanced: {
      geocodingEnabled: true,
      imageTag: parameters.has('invalid-advanced') ? 'invalid tag' : '',
      cacheVolumeSource: '/mnt/ssd/tilecache'
    }
  }

  const save = (nextConfiguration: Record<string, unknown>): void => {
    document.body.dataset.saveCount = String(Number(document.body.dataset.saveCount ?? 0) + 1)
    document.body.dataset.savedConfiguration = JSON.stringify(nextConfiguration)
  }

  createRoot(rootElement).render(
    <React.StrictMode>
      <Panel configuration={initialConfiguration} save={save} />
    </React.StrictMode>
  )
  document.body.dataset.fixtureReady = 'true'
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const errorElement = document.querySelector('#fixture-error')
  if (errorElement !== null) errorElement.textContent = message
  document.body.dataset.fixtureReady = 'false'
}
