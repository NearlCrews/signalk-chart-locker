/**
 * Root component of the federated configuration panel. The Signal K admin UI
 * loads it from remoteEntry.js and renders it in place of the generated
 * react-jsonschema-form, passing the current configuration and a
 * fire-and-forget save callback.
 */

import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Cluster,
  Disclosure,
  InlineConfirm,
  Metric,
  MetricGrid,
  PanelRoot,
  Section,
  Stack,
  supportsNativeCssScope,
  ThemeToggle
} from 'signalk-nearlcrews-ui'
import StatusBar from './components/StatusBar.js'
import RangeField from './components/RangeField.js'
import NumberField from './components/NumberField.js'
import TextField from './components/TextField.js'
import FooterBar from './components/FooterBar.js'
import { useConfig } from './hooks/use-config.js'
import { useStatus } from './hooks/use-status.js'
import { useCacheInfo } from './hooks/use-cache-info.js'
import { useCacheOperations } from './hooks/use-cache-operations.js'
import { useChartDiscovery } from './hooks/use-chart-discovery.js'
import {
  CACHE_CAP_DEFAULT_GIB,
  CACHE_CAP_MAX_GIB,
  CACHE_CAP_MIN_GIB,
  CACHE_CAP_STEP_GIB,
  REGIONS_BUDGET_DEFAULT_GIB,
  REGIONS_BUDGET_MIN_GIB
} from './config-types.js'
import styles from './PluginConfigurationPanel.module.css'

/** How long, in milliseconds, the "Saved" confirmation stays visible. */
const SAVED_NOTICE_MS = 2500

type PanelAction = 'retention' | 'clear-scroll' | 'refresh-cache' | 'rescan-charts'

function formatBytes (bytes: number | null): string {
  if (bytes === null) return 'Unknown'
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

interface Props {
  /** The plugin configuration supplied by the admin UI. Untyped at the federation boundary. */
  configuration: unknown
  /** Persists the configuration. Fire-and-forget: it returns void and must not be awaited. */
  save: (configuration: unknown) => void
}

/** The configuration panel rendered inside the Signal K admin UI. */
export default function PluginConfigurationPanel (props: Props): React.ReactElement {
  if (!supportsNativeCssScope(window)) {
    return (
      <div className={styles.compatibilityMessage} data-browser-compatibility-message='' role='alert'>
        <h2>Browser update required</h2>
        <p>
          This panel requires native CSS @scope. Update the browser or embedded WebView before
          reopening Signal K Admin.
        </p>
      </div>
    )
  }

  return <SupportedPluginConfigurationPanel {...props} />
}

function SupportedPluginConfigurationPanel ({ configuration, save }: Props): React.ReactElement {
  const { status, error, lastUpdatedMs } = useStatus()
  const {
    freeGiB,
    recommendedCapGiB,
    storage,
    usingFallback,
    error: cacheInfoError
  } = useCacheInfo()
  const cache = useCacheOperations()
  const charts = useChartDiscovery()
  const { state, savedState, dispatch, markSaved, reseed } = useConfig(configuration)
  const [justSavedAt, setJustSavedAt] = useState<number | null>(null)
  const [ttlDraft, setTtlDraft] = useState(30)
  const [actionError, setActionError] = useState<string | null>(null)
  const [clearScrollConfirmation, setClearScrollConfirmation] = useState(false)
  const [pendingAction, setPendingAction] = useState<PanelAction | null>(null)
  const pendingActionRef = useRef<PanelAction | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (cache.stats !== null) setTtlDraft(cache.stats.ttlDays)
  }, [cache.stats?.ttlDays])

  // Whether the plugin has ever been saved. The admin UI does not re-pass configuration after a
  // save, so this local state flips on the first save instead of deriving forever from the mount prop.
  const [everSaved, setEverSaved] = useState(configuration != null)

  useEffect(() => {
    if (justSavedAt === null) return
    const timeoutId = setTimeout(() => setJustSavedAt(null), SAVED_NOTICE_MS)
    return () => clearTimeout(timeoutId)
  }, [justSavedAt])

  // Every reducer case returns a new object only on a real change, so identity inequality against
  // the last-saved snapshot is a sound dirty check.
  const dirty = state !== savedState

  // Save stays enabled before the first configuration is persisted so defaults can enable the plugin.
  const unconfigured = !everSaved

  const validation = useMemo(() => {
    return {
      regionsBudget: state.tileCache.regionsBudgetGiB > state.tileCache.cacheCapGiB
        ? 'Saved-regions budget cannot exceed the cache cap.'
        : null,
      chartsPath: state.charts.path.startsWith('/') || state.charts.path.split(/[\\/]+/).includes('..')
        ? 'The PMTiles charts directory must stay relative to the Signal K configuration directory.'
        : null,
      cacheVolumeSource: state.advanced.cacheVolumeSource !== '' && !state.advanced.cacheVolumeSource.startsWith('/')
        ? 'The external cache drive must be an absolute host path.'
        : null,
      imageTag: state.advanced.imageTag !== '' && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(state.advanced.imageTag)
        ? 'The container image tag is not a valid OCI tag.'
        : null
    }
  }, [state])
  const validationErrors = Object.values(validation).filter((error): error is string => error !== null)
  const advancedInvalid = validation.imageTag !== null || validation.cacheVolumeSource !== null
  const [advancedOpen, setAdvancedOpen] = useState(advancedInvalid)

  useEffect(() => {
    if (advancedInvalid) setAdvancedOpen(true)
  }, [advancedInvalid])

  const restartChanges = useMemo(() => {
    if (!dirty) return []
    const changes: string[] = []
    if (state.tileCache !== savedState.tileCache) changes.push('tile-cache limits')
    if (state.charts !== savedState.charts) changes.push('chart discovery')
    if (state.advanced !== savedState.advanced) changes.push('container settings')
    return changes
  }, [dirty, state, savedState])

  const runAction = useCallback((
    key: PanelAction,
    action: () => Promise<void>,
    onSuccess?: () => void
  ): void => {
    // Ref-based suppression closes the gap before React commits the loading state.
    if (pendingActionRef.current !== null) return
    pendingActionRef.current = key
    setPendingAction(key)
    setActionError(null)
    Promise.resolve()
      .then(action)
      .then(() => {
        if (mountedRef.current) onSuccess?.()
      })
      .catch((cause) => {
        if (mountedRef.current) {
          setActionError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        pendingActionRef.current = null
        if (mountedRef.current) setPendingAction(null)
      })
  }, [])

  // Warn before a tab close or reload while edits are unsaved.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Seed the cache cap from detected free space once for a never-configured plugin. The guards keep
  // stored values and edits made while the cache-info request is in flight from being overwritten.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    if (!unconfigured || dirty) return
    if (recommendedCapGiB === null) return
    if (state.tileCache.cacheCapGiB !== CACHE_CAP_DEFAULT_GIB) return
    seededRef.current = true
    reseed({ ...state, tileCache: { ...state.tileCache, cacheCapGiB: recommendedCapGiB } })
  }, [unconfigured, dirty, recommendedCapGiB, state, reseed])

  // Read the latest state through a ref so the save callback remains identity-stable while editing.
  const stateRef = useRef(state)
  stateRef.current = state
  const handleSave = useCallback((): void => {
    save(stateRef.current)
    markSaved()
    setJustSavedAt(Date.now())
    setEverSaved(true)
  }, [save, markSaved])

  const handleDiscard = useCallback((): void => {
    dispatch({ type: 'discard', config: savedState })
  }, [dispatch, savedState])

  const slowUpstream = Object.entries(cache.stats?.upstream ?? {}).some(([, upstream]) => upstream.slow)

  return (
    <PanelRoot legacyThemeStorageKeys={['cl-theme']}>
      <Stack gap={4}>
        <Cluster justify='end'>
          <ThemeToggle />
        </Cluster>

        <StatusBar status={status} lastUpdatedMs={lastUpdatedMs} />

        {error !== null
          ? <Banner tone='danger' live='assertive'>Status unavailable: {error}. The next poll will retry automatically.</Banner>
          : null}
        {cache.stats !== null && !cache.stats.configured
          ? <Banner tone='warning' live='polite'>Tile cache is running but still waiting for its source and budget configuration.</Banner>
          : null}
        {cache.stats?.diskPressure === true
          ? <Banner tone='danger' live='assertive'>The cache filesystem is below its reserved free-space headroom. New tiles will be served without being cached.</Banner>
          : null}
        {slowUpstream
          ? <Banner tone='warning' live='polite'>One or more chart sources are responding slowly. Chart Locker has increased their request timeout automatically.</Banner>
          : null}
        {actionError !== null
          ? <Banner tone='danger' live='assertive'>Panel action failed: {actionError}</Banner>
          : null}
        {validationErrors.length > 0
          ? <Banner tone='danger' live='off'>Fix the highlighted configuration fields before saving.</Banner>
          : null}
        {restartChanges.length > 0
          ? <Banner tone='info' live='polite'>Saving will reapply {restartChanges.join(', ')} and may recreate the tile-cache container.</Banner>
          : null}

        <Section title='Cache operations' description='Live usage, source health, retention, and maintenance controls.'>
          <Stack gap={3}>
            {cache.stats === null
              ? (
                <p className={styles.secondaryText} role='status' aria-live='polite'>
                  {cache.error === null ? 'Loading cache statistics...' : `Statistics unavailable: ${cache.error}`}
                </p>
                )
              : (
                <>
                  {cache.error !== null
                    ? <Banner tone='warning' live='polite'>Cache statistics refresh failed: {cache.error}. Showing the last successful result.</Banner>
                    : null}
                  <MetricGrid>
                    {[
                      ['Used', formatBytes(cache.stats.bytes)],
                      ['Capacity', formatBytes(cache.stats.cap)],
                      ['Saved regions', formatBytes(cache.stats.pinnedBytes)],
                      ['Scroll cache', formatBytes(cache.stats.scrollBytes)],
                      ['Region headroom', formatBytes(cache.stats.regionsFreeBytes)],
                      ['Filesystem free', formatBytes(cache.stats.availableBytes)]
                    ].map(([label, value]) => <Metric key={label} label={label} value={value} />)}
                  </MetricGrid>

                  <NumberField
                    id='cl-scroll-ttl'
                    label='Scroll cache retention (days)'
                    min={0}
                    max={365}
                    integer
                    fallback={30}
                    value={ttlDraft}
                    onChange={setTtlDraft}
                    disabled={cache.busy}
                    hint='Unpinned tiles older than this are removed by the background sweep. Set 0 to disable age-based removal.'
                  />

                  <Cluster gap={2}>
                    <Button
                      variant='primary'
                      ariaDisabled={ttlDraft === cache.stats.ttlDays || (pendingAction !== null && pendingAction !== 'retention')}
                      loading={pendingAction === 'retention'}
                      loadingLabel='Applying retention'
                      onClick={() => runAction('retention', () => cache.setTtlDays(ttlDraft))}
                    >
                      Apply retention
                    </Button>
                    <Button
                      ariaDisabled={pendingAction !== null}
                      onClick={() => setClearScrollConfirmation(true)}
                    >
                      Clear scroll cache
                    </Button>
                    <Button
                      ariaDisabled={pendingAction !== null && pendingAction !== 'refresh-cache'}
                      loading={pendingAction === 'refresh-cache'}
                      loadingLabel='Refreshing cache statistics'
                      onClick={() => runAction('refresh-cache', cache.refresh)}
                    >
                      Refresh
                    </Button>
                  </Cluster>

                  <InlineConfirm
                    open={clearScrollConfirmation}
                    busy={pendingAction !== null || cache.busy}
                    headingLevel={3}
                    title='Clear scroll cache?'
                    message='Every unpinned scroll tile will be removed. Saved-region tiles will be kept.'
                    confirmLabel='Clear scroll cache'
                    onCancel={() => setClearScrollConfirmation(false)}
                    onConfirm={() => runAction('clear-scroll', cache.clearScroll, () => setClearScrollConfirmation(false))}
                  />

                  {cache.stats.bySource.length > 0
                    ? (
                      <div className={styles.tableRegion} role='region' aria-label='Cache usage by chart source' tabIndex={0}>
                        <table className={styles.table}>
                          <thead>
                            <tr><th scope='col'>Source</th><th scope='col'>Usage</th><th scope='col'>Tiles</th><th scope='col'>Upstream</th></tr>
                          </thead>
                          <tbody>
                            {cache.stats.bySource.map((source) => {
                              const slow = cache.stats?.upstream[source.source]?.slow === true
                              return (
                                <tr key={source.source}>
                                  <td>{source.source}</td>
                                  <td>{formatBytes(source.bytes)}</td>
                                  <td>{source.rows}</td>
                                  <td><Badge tone={slow ? 'warning' : 'neutral'}>{slow ? 'Slow' : 'Normal'}</Badge></td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                      )
                    : null}

                  <p className={styles.secondaryText}>
                    Diagnostics: {cache.stats.diagnostics.cacheOperationErrors} cache errors, {cache.stats.diagnostics.diskPressureEvents} disk-pressure events, and {cache.stats.diagnostics.warmRejections} rejected warm requests.
                  </p>
                </>
                )}
          </Stack>
        </Section>

        <Section
          title='Tile cache'
          description='The on-disk cache for map tiles, plus the budget reserved for saved regions you keep for offline use.'
        >
          <Stack gap={3}>
            <RangeField
              id='cl-cache-cap'
              label='Cache size cap (GiB)'
              min={CACHE_CAP_MIN_GIB}
              max={CACHE_CAP_MAX_GIB}
              step={CACHE_CAP_STEP_GIB}
              unit='GiB'
              value={state.tileCache.cacheCapGiB}
              onChange={(giB) => dispatch({ type: 'setCacheCapGiB', giB })}
              hint={
                <>
                  The most disk space the tile cache may use. When it reaches this size it evicts the
                  least recently used unpinned tiles to stay under the cap. Do not set this to all of
                  your free space: the cache grows to fill the cap, and a full disk can stop the server
                  from writing. Free-space guidance uses the external cache drive when one is configured
                  and available.
                </>
              }
            />
            {freeGiB !== null
              ? <p className={styles.secondaryText}>{freeGiB} GiB free on the {storage === 'external' ? 'external cache filesystem' : 'Signal K data filesystem'}.</p>
              : null}
            {usingFallback
              ? <Banner tone='warning' live='polite'>The configured external cache path is unavailable, so free space is measured on the Signal K data filesystem.</Banner>
              : null}
            {cacheInfoError !== null
              ? <Banner tone='warning' live='polite'>Filesystem-specific cache guidance is unavailable: {cacheInfoError}. The static cache limits remain available.</Banner>
              : null}
            {freeGiB !== null && state.tileCache.cacheCapGiB > freeGiB
              ? (
                <Banner tone='warning' live='polite'>
                  Cache cap exceeds free space. Reduce it, or move the cache to an external drive under
                  Advanced.
                </Banner>
                )
              : null}
            <NumberField
              id='cl-regions-budget'
              label='Saved-regions reserved budget (GiB)'
              min={REGIONS_BUDGET_MIN_GIB}
              integer
              step={1}
              fallback={REGIONS_BUDGET_DEFAULT_GIB}
              value={state.tileCache.regionsBudgetGiB}
              onChange={(giB) => dispatch({ type: 'setRegionsBudgetGiB', giB })}
              error={validation.regionsBudget}
              errorLive='polite'
              hint={
                <>
                  A ceiling on how much of the cache saved regions may pin. Leave 0 to reserve half the
                  cache cap. This is not space taken from the scroll cache until a region is actually
                  saved. The value must not exceed the cache cap.
                </>
              }
            />
          </Stack>
        </Section>

        <Section title='Charts' description='Local PMTiles charts served by the plugin.'>
          <Stack gap={3}>
            <TextField
              id='cl-charts-path'
              label='PMTiles charts directory'
              placeholder='charts/pmtiles'
              value={state.charts.path}
              onChange={(path) => dispatch({ type: 'setChartsPath', path })}
              error={validation.chartsPath}
              errorLive='polite'
              hint={
                <>
                  Directory holding .pmtiles charts, relative to the Signal K config path. Leave blank
                  for the default charts/pmtiles.
                </>
              }
            />
            {charts.discovery !== null
              ? (
                <>
                  <p className={styles.secondaryText}>
                    {charts.discovery.valid} valid chart{charts.discovery.valid === 1 ? '' : 's'}, {charts.discovery.invalid.length} invalid. {charts.discovery.lastScanAt === null ? 'Not scanned yet.' : `Last scanned ${new Date(charts.discovery.lastScanAt).toLocaleString()}.`}
                  </p>
                  {charts.discovery.invalid.map((item) => (
                    <Banner key={item.fileName} tone='warning' live='polite'>{item.fileName}: {item.error}</Banner>
                  ))}
                </>
                )
              : null}
            {charts.error !== null
              ? <Banner tone='warning' live='polite'>Chart discovery unavailable: {charts.error}</Banner>
              : null}
            <Cluster>
              <Button
                ariaDisabled={pendingAction !== null && pendingAction !== 'rescan-charts'}
                loading={pendingAction === 'rescan-charts'}
                loadingLabel='Rescanning charts'
                onClick={() => runAction('rescan-charts', charts.rescan)}
              >
                Rescan charts
              </Button>
            </Cluster>
          </Stack>
        </Section>

        <Disclosure
          title='Advanced'
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
        >
          <Stack gap={3}>
            <p className={styles.secondaryText}>Settings most installs never change.</p>
            <Checkbox
              checked={state.advanced.geocodingEnabled}
              description={
                <>
                  Allow place-name searches to contact OpenStreetMap Nominatim. Disable this setting
                  to prevent those outbound requests.
                </>
              }
              label='Enable place-name lookup'
              onChange={(event) => dispatch({ type: 'setGeocodingEnabled', enabled: event.currentTarget.checked })}
            />
            <TextField
              id='cl-image-tag'
              label='Tile cache container image tag'
              placeholder='Pinned to the plugin version'
              value={state.advanced.imageTag}
              onChange={(tag) => dispatch({ type: 'setImageTag', tag })}
              error={validation.imageTag}
              errorLive='polite'
              hint={
                <>
                  The image tag to run for the tile cache and proxy container. Pinned to the plugin
                  version, so change it only to test a specific build. Leave blank to use the pinned
                  default.
                </>
              }
            />
            <TextField
              id='cl-cache-volume-source'
              label='External tile cache drive'
              placeholder='/mnt/ssd/tilecache'
              value={state.advanced.cacheVolumeSource}
              onChange={(path) => dispatch({ type: 'setCacheVolumeSource', path })}
              error={validation.cacheVolumeSource}
              errorLive='polite'
              hint={
                <>
                  Host path of a USB SSD or NVMe drive to hold the tile cache. Leave blank to keep the
                  cache on the Signal K data directory.
                </>
              }
            />
          </Stack>
        </Disclosure>

        <FooterBar
          dirty={dirty}
          unconfigured={unconfigured}
          justSavedAt={justSavedAt}
          onSave={handleSave}
          onDiscard={handleDiscard}
          valid={validationErrors.length === 0}
        />
      </Stack>
    </PanelRoot>
  )
}
