/**
 * Root component of the federated configuration panel. The Signal K admin UI
 * loads it from remoteEntry.js and renders it in place of the generated
 * react-jsonschema-form, passing the current configuration and a
 * fire-and-forget save callback.
 */

import type * as React from 'react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Cluster,
  Code,
  CollapsibleSection,
  InlineConfirm,
  LabeledField,
  LiveRegion,
  Metric,
  MetricGrid,
  NumberField,
  PanelShell,
  RelativeAge,
  Section,
  Stack,
  StatusIndicator,
  Text,
  TextInput,
  useUnsavedChangesGuard
} from 'signalk-nearlcrews-ui'
import {
  EmptyState,
  SaveActionBar,
  Table,
  TableCell,
  TableHeaderCell,
  TableScrollRegion
} from 'signalk-nearlcrews-ui/composites'
import StatusBar from './components/StatusBar.js'
import RangeField from './components/RangeField.js'
import { PANEL_AGE_TICK_MS } from './age-tick.js'
import { formatBytes, splitBytes } from './format-bytes.js'
import { useConfig } from './hooks/use-config.js'
import { useStatus } from './hooks/use-status.js'
import { useCacheInfo } from './hooks/use-cache-info.js'
import { useCacheOperations } from './hooks/use-cache-operations.js'
import { useChartDiscovery } from './hooks/use-chart-discovery.js'
import { isRequestTimeout } from './hooks/use-abortable-fetch.js'
import {
  CACHE_CAP_DEFAULT_GIB,
  CACHE_CAP_MAX_GIB,
  CACHE_CAP_MIN_GIB,
  CACHE_CAP_STEP_GIB,
  REGIONS_BUDGET_DEFAULT_GIB,
  REGIONS_BUDGET_MIN_GIB,
  SCROLL_CACHE_TTL_DEFAULT_DAYS,
  SCROLL_CACHE_TTL_MAX_DAYS,
  SCROLL_CACHE_TTL_MIN_DAYS
} from './config-types.js'
import { type PanelValidation, validatePanelConfig } from './validate-config.js'
import { MAX_CONFIG_PATH_LENGTH } from '../shared/config-path.js'

/** How long, in milliseconds, the save-request confirmation stays visible. */
const SAVE_REQUEST_NOTICE_MS = 2500

/**
 * How the save bar names each invalid field. The message has to name the field because an invalid
 * Advanced setting can sit inside a collapsed section, where "fix the highlighted fields" points at
 * nothing the operator can see.
 */
const INVALID_FIELD_LABELS: Readonly<Record<keyof PanelValidation, string>> = {
  regionsBudget: 'the saved-regions reserved budget',
  chartsPath: 'the PMTiles charts directory',
  imageTag: 'the tile cache container image tag under Advanced',
  cacheVolumeSource: 'the external tile cache drive under Advanced'
}

/** The fields to test, in the order the save bar counts them. */
const VALIDATED_FIELDS = Object.keys(INVALID_FIELD_LABELS) as Array<keyof PanelValidation>

/** How many unreadable chart files the warning lists by name before it summarizes the rest. */
const MAX_LISTED_INVALID_CHARTS = 5

type PanelAction = 'retention' | 'clear-scroll' | 'refresh-cache' | 'rescan-charts'

/** What each action is doing, for the sentence below. */
const ACTION_IN_PROGRESS: Readonly<Record<PanelAction, string>> = {
  retention: 'applying the retention change',
  'clear-scroll': 'clearing the scroll cache',
  'refresh-cache': 'reading cache statistics',
  'rescan-charts': 'rescanning charts'
}

/**
 * What the panel says when a maintenance action outlives its request budget. The server has not
 * failed: it is still working, and the cache poll and the chart reload both reconcile the real
 * outcome on their own, so this reports the loss of the answer rather than the loss of the work.
 */
function describeStillRunning (action: PanelAction): string {
  return `Chart Locker is still ${ACTION_IN_PROGRESS[action]}. The panel will show the result on its next refresh.`
}

/** How the retention outcome is spelled, so 0 does not announce as a duration. */
function describeRetention (days: number): string {
  if (days === SCROLL_CACHE_TTL_MIN_DAYS) return 'Scroll cache retention disabled. Tiles are no longer removed by age.'
  return `Scroll cache retention set to ${days} day${days === 1 ? '' : 's'}.`
}

/** The chart counts, shared by the visible summary and its announcement. */
function describeChartCounts (valid: number, invalid: number): string {
  return `${valid.toLocaleString()} valid chart${valid === 1 ? '' : 's'}, ${invalid.toLocaleString()} invalid`
}

/**
 * Join the conditions that currently hold into one announcement, each ending in a full stop.
 *
 * Every active condition is carried rather than only the most severe, so a condition that arises
 * while another is already up is never dropped. An unchanged set produces an identical string, which
 * leaves the region's text untouched and announces nothing.
 */
function announce (...texts: Array<string | null>): string {
  return texts
    .filter((text): text is string => text !== null && text !== '')
    .map((text) => (text.endsWith('.') ? text : `${text}.`))
    .join(' ')
}

interface Props {
  /** The plugin configuration supplied by the admin UI. Untyped at the federation boundary. */
  configuration: unknown
  /** Requests a configuration save. Fire-and-forget: it returns void and must not be awaited. */
  save: (configuration: unknown) => void
}

/** The error boundary's second action, for the case where a retry cannot recover the panel. */
function reloadPage (): void {
  window.location.reload()
}

/**
 * The configuration panel rendered inside the Signal K admin UI. The shell runs the browser
 * preflight, owns the theme toggle, and catches a render error inside the body so the operator gets
 * a retry in place instead of the Admin host's generic unavailable notice.
 */
export default function PluginConfigurationPanel (props: Props): React.ReactElement {
  return (
    <PanelShell themeToggle='end' onReload={reloadPage}>
      <PanelBody {...props} />
    </PanelShell>
  )
}

function PanelBody ({ configuration, save }: Props): React.ReactElement {
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
  const { state, requestedState, dispatch, markSaveRequested, reseed } = useConfig(configuration)
  const [saveRequestedAt, setSaveRequestedAt] = useState<number | null>(null)
  const [ttlDraft, setTtlDraft] = useState(SCROLL_CACHE_TTL_DEFAULT_DAYS)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionStillRunning, setActionStillRunning] = useState<string | null>(null)
  const [actionOutcome, setActionOutcome] = useState('')
  const [clearScrollConfirmation, setClearScrollConfirmation] = useState(false)
  const [pendingAction, setPendingAction] = useState<PanelAction | null>(null)
  const pendingActionRef = useRef<PanelAction | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Reseed the retention box from the server, but only while it still holds what the server last
  // reported. A second admin, or the plugin's own recovery path, can change retention mid-edit, and
  // the operator's typing has to survive that; the Apply button stays enabled because the draft no
  // longer matches the server, so the change is theirs to make.
  const lastServerTtlRef = useRef<number | null>(null)
  useEffect(() => {
    const serverTtl = cache.stats?.ttlDays
    if (serverTtl === undefined) return
    const lastServerTtl = lastServerTtlRef.current
    lastServerTtlRef.current = serverTtl
    setTtlDraft((current) => (lastServerTtl === null || current === lastServerTtl ? serverTtl : current))
  }, [cache.stats?.ttlDays])

  // Whether the plugin has received a save request. The admin UI does not re-pass configuration
  // after a request, so this local state flips instead of deriving forever from the mount prop.
  const [saveWasRequested, setSaveWasRequested] = useState(configuration != null)

  // The save bar shows "Save requested" for as long as the timestamp is set, so the panel owns the
  // notice's lifetime and clears it after a short while.
  useEffect(() => {
    if (saveRequestedAt === null) return
    const timeoutId = setTimeout(() => setSaveRequestedAt(null), SAVE_REQUEST_NOTICE_MS)
    return () => clearTimeout(timeoutId)
  }, [saveRequestedAt])

  // Every reducer case returns a new object only on a real change, so identity inequality against
  // the last-requested snapshot is a sound dirty check.
  const dirty = state !== requestedState

  // Save stays enabled before the first request so defaults can enable the plugin.
  const unconfigured = !saveWasRequested

  const validation = useMemo(() => validatePanelConfig(state), [state])
  const invalidFields = VALIDATED_FIELDS.filter((field) => validation[field] !== null)
  // One sentence for one state. A single invalid field is named, because the operator has to be
  // able to find it; several are counted, because listing them all would outgrow the save bar.
  const invalidMessage = invalidFields.length === 0
    ? null
    : invalidFields.length === 1
      ? `Fix ${INVALID_FIELD_LABELS[invalidFields[0]]} before saving.`
      : `Fix the ${invalidFields.length} highlighted configuration fields before saving.`
  const advancedProblems = [validation.imageTag, validation.cacheVolumeSource]
    .filter((error) => error !== null).length
  const advancedInvalid = advancedProblems > 0
  const [advancedOpen, setAdvancedOpen] = useState(advancedInvalid)

  useEffect(() => {
    if (advancedInvalid) setAdvancedOpen(true)
  }, [advancedInvalid])

  const restartChanges = useMemo(() => {
    if (!dirty) return []
    const changes: string[] = []
    if (state.tileCache !== requestedState.tileCache) changes.push('tile-cache limits')
    if (state.charts !== requestedState.charts) changes.push('chart discovery')
    if (state.advanced !== requestedState.advanced) changes.push('container settings')
    return changes
  }, [dirty, state, requestedState])

  const runAction = useCallback(<T, >(
    key: PanelAction,
    action: () => Promise<T>,
    onSuccess?: (result: T) => void
  ): void => {
    // Ref-based suppression closes the gap before React commits the loading state.
    if (pendingActionRef.current !== null) return
    pendingActionRef.current = key
    setPendingAction(key)
    setActionError(null)
    setActionStillRunning(null)
    // Clearing the outcome first is what makes a repeated identical result announce again: the
    // announcer's text goes back to empty between runs, so the next one is a change rather than
    // the same string written twice.
    setActionOutcome('')
    Promise.resolve()
      .then(action)
      .then((result) => {
        if (mountedRef.current) onSuccess?.(result)
      })
      .catch((cause) => {
        if (!mountedRef.current) return
        // An expired budget on a write is not a failure: the route has the request and is still
        // working on it. Saying "failed" here would push the operator into running it a second time.
        if (isRequestTimeout(cause)) setActionStillRunning(describeStillRunning(key))
        else setActionError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        pendingActionRef.current = null
        if (mountedRef.current) setPendingAction(null)
      })
  }, [])

  // Warn before a tab close or reload while edits are unsaved.
  useUnsavedChangesGuard(dirty)

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
    markSaveRequested()
    setSaveRequestedAt(Date.now())
    setSaveWasRequested(true)
  }, [save, markSaveRequested])

  const handleDiscard = useCallback((): void => {
    dispatch({ type: 'discard', config: requestedState })
  }, [dispatch, requestedState])

  const slowUpstream = Object.entries(cache.stats?.upstream ?? {}).some(([, upstream]) => upstream.slow)
  const invalidChartCount = charts.discovery?.invalid.length ?? 0

  // Every banner's words in one place. A live region only announces text that changes inside a
  // region that already existed, so the banners below are visual surfaces with no `live` of their
  // own and the announcers at the top of the panel carry the words. Reading both from this one
  // table is what keeps the announcement and the banner from drifting apart.
  const messages = {
    statusUnavailable: error === null
      ? null
      : `Status unavailable: ${error}. The next poll will retry automatically.`,
    diskPressure: cache.stats?.diskPressure === true
      ? 'The cache filesystem is below its reserved free-space headroom. New tiles will be served without being cached.'
      : null,
    actionFailed: actionError === null ? null : `Panel action failed: ${actionError}`,
    tileCacheUnconfigured: cache.stats !== null && !cache.stats.configured
      ? 'Tile cache is running but still waiting for its source and budget configuration.'
      : null,
    slowUpstream: slowUpstream
      ? 'One or more chart sources are responding slowly. Chart Locker has increased their request timeout automatically.'
      : null,
    cacheRefreshFailed: cache.stats !== null && cache.error !== null
      ? `Cache statistics refresh failed: ${cache.error}. Showing the last successful result.`
      : null,
    externalCacheFallback: usingFallback
      ? 'The configured external cache path is unavailable, so free space is measured on the Signal K data filesystem.'
      : null,
    cacheGuidanceUnavailable: cacheInfoError === null
      ? null
      : `Filesystem-specific cache guidance is unavailable: ${cacheInfoError}. The static cache limits remain available.`,
    capExceedsFreeSpace: freeGiB !== null && state.tileCache.cacheCapGiB > freeGiB
      ? 'Cache cap exceeds free space. Reduce it, or move the cache to an external drive under Advanced.'
      : null,
    invalidCharts: invalidChartCount === 0
      ? null
      : `${invalidChartCount.toLocaleString()} chart file${invalidChartCount === 1 ? '' : 's'} could not be read`,
    chartDiscoveryUnavailable: charts.error === null ? null : `Chart discovery unavailable: ${charts.error}`,
    restartOnSave: restartChanges.length === 0
      ? null
      : `Saving will reapply ${restartChanges.join(', ')} and may recreate the tile-cache container.`
  }

  // A scan that found nothing at all gets an orientation instead of a count of zero, because a
  // count of zero says nothing about where the files belong or what a chart file looks like. A
  // directory holding only unreadable files is not empty: the warning below explains that case.
  const chartsDirectoryEmpty = charts.discovery !== null &&
    charts.discovery.valid === 0 &&
    invalidChartCount === 0
  const chartsDirectory = state.charts.path === '' ? 'charts/pmtiles' : state.charts.path

  // One button, rendered either as the empty state's own next step or below the chart summary, so
  // the empty state can carry an action without putting a second identical button beside it.
  const rescanButton = (
    <Button
      ariaDisabled={pendingAction !== null && pendingAction !== 'rescan-charts'}
      loading={pendingAction === 'rescan-charts'}
      loadingLabel='Rescanning charts'
      onClick={() => runAction('rescan-charts', charts.rescan, (result) => {
        setActionOutcome(result === null
          ? 'Charts rescanned.'
          : `Charts rescanned: ${describeChartCounts(result.valid, result.invalid.length)}.`)
      })}
    >
      Rescan charts
    </Button>
  )

  return (
    <>
      {/*
        * Three announcers, mounted for the panel's whole life and empty until they have something
        * to say. Interrupting conditions are separated from routine ones so a cleared cache never
        * cuts across a screen reader, and an action's own outcome gets its own region so reporting
        * it does not re-announce every ambient condition beside it.
        *
        * Each carries data-panel-announcer because the panel shell mounts an announcer of its own,
        * so role alone no longer tells the panel's regions from the shell's.
        */}
      <LiveRegion
        data-panel-announcer='assertive'
        live='assertive'
        message={announce(messages.statusUnavailable, messages.diskPressure, messages.actionFailed)}
      />
      <LiveRegion
        data-panel-announcer='polite'
        live='polite'
        message={announce(
          messages.tileCacheUnconfigured,
          messages.slowUpstream,
          messages.cacheRefreshFailed,
          messages.externalCacheFallback,
          messages.cacheGuidanceUnavailable,
          messages.capExceedsFreeSpace,
          messages.invalidCharts,
          messages.chartDiscoveryUnavailable,
          messages.restartOnSave,
          actionStillRunning
        )}
      />
      <LiveRegion data-panel-announcer='polite' live='polite' message={actionOutcome} />

      <StatusBar status={status} lastUpdatedMs={lastUpdatedMs} />

      {messages.statusUnavailable !== null
        ? <Banner tone='danger'>{messages.statusUnavailable}</Banner>
        : null}
      {messages.tileCacheUnconfigured !== null
        ? <Banner tone='warning'>{messages.tileCacheUnconfigured}</Banner>
        : null}
      {messages.diskPressure !== null
        ? <Banner tone='danger'>{messages.diskPressure}</Banner>
        : null}
      {messages.slowUpstream !== null
        ? <Banner tone='warning'>{messages.slowUpstream}</Banner>
        : null}
      {messages.actionFailed !== null
        ? <Banner tone='danger'>{messages.actionFailed}</Banner>
        : null}
      {actionStillRunning !== null
        ? <Banner tone='info'>{actionStillRunning}</Banner>
        : null}
      {messages.restartOnSave !== null
        ? <Banner tone='info'>{messages.restartOnSave}</Banner>
        : null}

      <Section title='Cache operations' description='Live usage, source health, retention, and maintenance controls.'>
        <Stack gap={3}>
          {cache.stats === null
            ? (
              // One live status that stays mounted from the loading line through a failure, so the
              // failure text is announced as an update to a region that already existed.
              <StatusIndicator tone={cache.error === null ? 'neutral' : 'warning'} live='polite'>
                {cache.error === null ? 'Loading cache statistics...' : `Statistics unavailable: ${cache.error}`}
              </StatusIndicator>
              )
            : (
              <>
                {messages.cacheRefreshFailed !== null
                  ? <Banner tone='warning'>{messages.cacheRefreshFailed}</Banner>
                  : null}
                <MetricGrid>
                  {([
                    ['Used', cache.stats.bytes],
                    ['Capacity', cache.stats.cap],
                    ['Saved regions', cache.stats.pinnedBytes],
                    ['Scroll cache', cache.stats.scrollBytes],
                    ['Region headroom', cache.stats.regionsFreeBytes],
                    ['Filesystem free', cache.stats.availableBytes]
                  ] as const).map(([label, bytes]) => {
                    const { value, unit } = splitBytes(bytes)
                    return <Metric key={label} label={label} value={value} unit={unit} />
                  })}
                </MetricGrid>

                <NumberField
                  label='Scroll cache retention'
                  unit='days'
                  layout='inline'
                  min={SCROLL_CACHE_TTL_MIN_DAYS}
                  max={SCROLL_CACHE_TTL_MAX_DAYS}
                  integer
                  // Clearing the box restores the shipped default rather than committing the
                  // minimum, because the minimum here is 0, which turns age-based removal off
                  // entirely. An emptied field is not a request to disable the sweep.
                  fallback={SCROLL_CACHE_TTL_DEFAULT_DAYS}
                  value={ttlDraft}
                  onValueChange={setTtlDraft}
                  // Only its own operation takes the field away: clearing the scroll cache has
                  // nothing to do with retention and must not disable a field the operator is using.
                  disabled={pendingAction === 'retention'}
                  description='Unpinned tiles older than this are removed by the background sweep. Set 0 to disable age-based removal.'
                />

                {/* 12 px rather than the default 8, so three adjacent buttons stay comfortably
                    separate under a gloved finger on a nav-station tablet. */}
                <Cluster gap={3}>
                  <Button
                    variant='primary'
                    ariaDisabled={ttlDraft === cache.stats.ttlDays || (pendingAction !== null && pendingAction !== 'retention')}
                    loading={pendingAction === 'retention'}
                    loadingLabel='Applying retention'
                    onClick={() => runAction(
                      'retention',
                      () => cache.setTtlDays(ttlDraft),
                      () => setActionOutcome(describeRetention(ttlDraft))
                    )}
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
                    onClick={() => runAction(
                      'refresh-cache',
                      cache.refresh,
                      () => setActionOutcome('Cache statistics refreshed.')
                    )}
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
                  onConfirm={() => runAction('clear-scroll', cache.clearScroll, () => {
                    setClearScrollConfirmation(false)
                    setActionOutcome('Scroll cache cleared.')
                  })}
                />

                {/*
                  * The shared Table rather than DataGrid: the data-grid entry point pulls
                  * react-aria-components and react-stately into the remote, measured at 103 KiB gzip
                  * against a few KiB for this markup. The breakdown is bounded at 256 sources and is
                  * usually two or three, so nothing here needs sorting or virtualization.
                  */}
                {cache.stats.bySource.length > 0
                  ? (
                    <TableScrollRegion aria-label='Cache usage by chart source'>
                      <Table caption='Cache usage by chart source' captionVisibility='hidden'>
                        <thead>
                          <tr>
                            <TableHeaderCell>Source</TableHeaderCell>
                            <TableHeaderCell numeric>Usage</TableHeaderCell>
                            <TableHeaderCell numeric>Tiles</TableHeaderCell>
                            <TableHeaderCell>Upstream</TableHeaderCell>
                          </tr>
                        </thead>
                        <tbody>
                          {cache.stats.bySource.map((source) => {
                            const slow = cache.stats?.upstream[source.source]?.slow === true
                            return (
                              <tr key={source.source}>
                                <TableCell><Code>{source.source}</Code></TableCell>
                                <TableCell numeric>{formatBytes(source.bytes)}</TableCell>
                                <TableCell numeric>{source.rows.toLocaleString()}</TableCell>
                                <TableCell><Badge tone={slow ? 'warning' : 'neutral'}>{slow ? 'Slow' : 'Normal'}</Badge></TableCell>
                              </tr>
                            )
                          })}
                        </tbody>
                      </Table>
                    </TableScrollRegion>
                    )
                  : null}

                <Text as='p' tone='muted' size='sm'>
                  Diagnostics: {cache.stats.diagnostics.cacheOperationErrors} cache errors, {cache.stats.diagnostics.diskPressureEvents} disk-pressure events, and {cache.stats.diagnostics.warmRejections} rejected warm requests.
                </Text>
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
            label='Cache size cap'
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
            ? <Text as='p' tone='muted' size='sm'>{freeGiB.toLocaleString()} GiB free on the {storage === 'external' ? 'external cache filesystem' : 'Signal K data filesystem'}.</Text>
            : null}
          {messages.externalCacheFallback !== null
            ? <Banner tone='warning'>{messages.externalCacheFallback}</Banner>
            : null}
          {messages.cacheGuidanceUnavailable !== null
            ? <Banner tone='warning'>{messages.cacheGuidanceUnavailable}</Banner>
            : null}
          {messages.capExceedsFreeSpace !== null
            ? <Banner tone='warning'>{messages.capExceedsFreeSpace}</Banner>
            : null}
          <NumberField
            label='Saved-regions reserved budget'
            unit='GiB'
            layout='inline'
            min={REGIONS_BUDGET_MIN_GIB}
            integer
            fallback={REGIONS_BUDGET_DEFAULT_GIB}
            value={state.tileCache.regionsBudgetGiB}
            onValueChange={(giB) => dispatch({ type: 'setRegionsBudgetGiB', giB })}
            error={validation.regionsBudget}
            errorLive='polite'
            description={
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
          <LabeledField
            label='PMTiles charts directory'
            layout='inline'
            error={validation.chartsPath}
            errorLive='polite'
            description={
              <>
                Directory holding .pmtiles charts, relative to the Signal K config path. Leave blank
                for the default charts/pmtiles.
              </>
            }
          >
            <TextInput
              placeholder='charts/pmtiles'
              maxLength={MAX_CONFIG_PATH_LENGTH}
              value={state.charts.path}
              onChange={(event) => dispatch({ type: 'setChartsPath', path: event.target.value })}
            />
          </LabeledField>
          {chartsDirectoryEmpty
            ? (
              <EmptyState
                title='No charts found'
                description={`Put .pmtiles files in ${chartsDirectory} under the Signal K configuration directory, then rescan. Vector (MVT) and raster (PNG, JPEG, WebP, and AVIF) archives are all supported.`}
                action={rescanButton}
              />
              )
            : null}
          {charts.discovery !== null && !chartsDirectoryEmpty
            ? (
              <Text as='p' tone='muted' size='sm'>
                {describeChartCounts(charts.discovery.valid, charts.discovery.invalid.length)}.{' '}
                {charts.discovery.lastScanAt === null
                  ? 'Not scanned yet.'
                  : <>Last scanned <RelativeAge since={charts.discovery.lastScanAt} tickMs={PANEL_AGE_TICK_MS} />.</>}
              </Text>
              )
            : null}
          {/*
            * One banner for the whole list, capped. The parser bounds the invalid list at 4096, so
            * a charts directory pointed at the wrong folder would otherwise render thousands of
            * full-width banners and bury every other control on the page.
            */}
          {messages.invalidCharts !== null && charts.discovery !== null
            ? (
              <Banner tone='warning' title={messages.invalidCharts}>
                {/* Stack wraps each child in its own list item, so these are bare fragments. */}
                <Stack as='ul' gap={1}>
                  {charts.discovery.invalid.slice(0, MAX_LISTED_INVALID_CHARTS).map((item) => (
                    <Fragment key={item.fileName}><Code>{item.fileName}</Code>: {item.error}</Fragment>
                  ))}
                </Stack>
                {invalidChartCount > MAX_LISTED_INVALID_CHARTS
                  ? (
                    <Text as='p' size='sm'>
                      {(invalidChartCount - MAX_LISTED_INVALID_CHARTS).toLocaleString()} more not listed.
                    </Text>
                    )
                  : null}
              </Banner>
              )
            : null}
          {messages.chartDiscoveryUnavailable !== null
            ? <Banner tone='warning'>{messages.chartDiscoveryUnavailable}</Banner>
            : null}
          {chartsDirectoryEmpty ? null : <Cluster>{rescanButton}</Cluster>}
        </Stack>
      </Section>

      {/*
        * The header badge is the cue for a problem the operator cannot see. Advanced re-opens
        * itself when a stored setting turns invalid, but nothing stops them collapsing it again,
        * and a save blocked by a field hidden behind a closed section needs a marker on the section
        * itself as well as the field's name in the save bar.
        */}
      <CollapsibleSection
        title='Advanced'
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        actions={advancedInvalid
          ? <Badge tone='danger'>{advancedProblems} problem{advancedProblems === 1 ? '' : 's'}</Badge>
          : undefined}
      >
        <Stack gap={3}>
          <Text as='p' tone='muted' size='sm'>Settings most installs never change.</Text>
          <Checkbox
            checked={state.advanced.geocodingEnabled}
            description={
              <>
                Allow Chart Locker to name a saved region from its coordinates using OpenStreetMap
                Nominatim. Disable this setting to prevent that outbound request.
              </>
            }
            label='Enable reverse geocoding'
            onChange={(event) => dispatch({ type: 'setGeocodingEnabled', enabled: event.currentTarget.checked })}
          />
          <LabeledField
            label='Tile cache container image tag'
            layout='inline'
            error={validation.imageTag}
            errorLive='polite'
            description={
              <>
                The image tag to run for the tile cache and proxy container. Pinned to the plugin
                version, so change it only to test a specific build. Leave blank to use the pinned
                default.
              </>
            }
          >
            <TextInput
              placeholder='Pinned to the plugin version'
              maxLength={128}
              value={state.advanced.imageTag}
              onChange={(event) => dispatch({ type: 'setImageTag', tag: event.target.value })}
            />
          </LabeledField>
          <LabeledField
            label='External tile cache drive'
            layout='inline'
            error={validation.cacheVolumeSource}
            errorLive='polite'
            description={
              <>
                Host path of a USB SSD or NVMe drive to hold the tile cache. Leave blank to keep the
                cache on the Signal K data directory.
              </>
            }
          >
            <TextInput
              placeholder='/mnt/ssd/tilecache'
              maxLength={MAX_CONFIG_PATH_LENGTH}
              value={state.advanced.cacheVolumeSource}
              onChange={(event) => dispatch({ type: 'setCacheVolumeSource', path: event.target.value })}
            />
          </LabeledField>
        </Stack>
      </CollapsibleSection>

      <SaveActionBar
        data-panel-action-bar=''
        dirty={dirty}
        unconfigured={unconfigured}
        saveRequestedAt={saveRequestedAt}
        invalidMessage={invalidMessage}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
    </>
  )
}
