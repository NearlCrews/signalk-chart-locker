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
  type BannerTone,
  Button,
  Checkbox,
  Cluster,
  Code,
  CollapsibleSection,
  formatCount,
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
  usePanelAnnouncer,
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
import { DEFAULT_CHARTS_SUBPATH, MAX_CONFIG_PATH_LENGTH } from '../shared/config-path.js'
import { MAX_IMAGE_TAG_LENGTH } from '../shared/image-tag.js'

/** How long, in milliseconds, the save-request confirmation stays visible. */
const SAVE_REQUEST_NOTICE_MS = 2500

/**
 * Every field the panel validates: the label its own control shows, and whether it lives under
 * Advanced.
 *
 * The save bar has to name the field, because an invalid Advanced setting can sit inside a collapsed
 * section where "fix the highlighted fields" points at nothing the operator can see. The control's
 * label, the save bar's phrasing, and the Advanced badge's count all read this one table, so a
 * renamed field cannot leave the save bar pointing at a name that is no longer on screen and a new
 * Advanced field cannot be counted by the save bar but missed by the section header.
 */
const VALIDATED_FIELDS: Readonly<Record<keyof PanelValidation, { label: string, advanced: boolean }>> = {
  regionsBudget: { label: 'Saved-regions reserved budget', advanced: false },
  chartsPath: { label: 'PMTiles charts directory', advanced: false },
  imageTag: { label: 'Tile cache container image tag', advanced: true },
  cacheVolumeSource: { label: 'External tile cache drive', advanced: true }
}

/** The fields to test, in the order the save bar counts them. */
const VALIDATED_FIELD_KEYS = Object.keys(VALIDATED_FIELDS) as Array<keyof PanelValidation>

/**
 * How the save bar names one invalid field: its own label, mid-sentence, plus where to find it. A
 * label that opens with an acronym keeps its capitals, because "pMTiles" names nothing.
 */
function describeField (key: keyof PanelValidation): string {
  const { label, advanced } = VALIDATED_FIELDS[key]
  const opening = /^[A-Z][a-z]/.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label
  return `the ${opening}${advanced ? ' under Advanced' : ''}`
}

/** How many unreadable chart files the warning lists by name before it summarizes the rest. */
const MAX_LISTED_INVALID_CHARTS = 5

type PanelAction = 'retention' | 'clear-scroll' | 'refresh-cache' | 'rescan-charts'

/**
 * How each action reads while it runs: the phrase the still-running sentence uses, and the label the
 * button that starts it shows. Clearing the scroll cache carries no button label, because its inline
 * confirmation owns the busy state rather than the trigger beside it.
 */
const PANEL_ACTIONS: Readonly<Record<PanelAction, { inProgress: string, loadingLabel?: string }>> = {
  retention: { inProgress: 'applying the retention change', loadingLabel: 'Applying retention' },
  'clear-scroll': { inProgress: 'clearing the scroll cache' },
  'refresh-cache': { inProgress: 'refreshing cache statistics', loadingLabel: 'Refreshing cache statistics' },
  'rescan-charts': { inProgress: 'rescanning charts', loadingLabel: 'Rescanning charts' }
}

/** What a button shows while the panel is busy, taken from the action it starts. */
interface ActionProps {
  ariaDisabled: boolean
  loading: boolean
  loadingLabel: string | undefined
}

/**
 * What the panel says when a maintenance action outlives its request budget. The server has not
 * failed: it is still working, and the cache poll and the chart reload both reconcile the real
 * outcome on their own, so this reports the loss of the answer rather than the loss of the work.
 */
function describeStillRunning (action: PanelAction): string {
  return `Chart Locker is still ${PANEL_ACTIONS[action].inProgress}. The panel will show the result on its next refresh.`
}

/**
 * A counted noun carrying the operator's own digit grouping. The plural rule is the package's, so
 * the panel's sentences and the words the library renders beside them cannot disagree; the grouping
 * is the panel's own, because a chart count reaches four digits.
 */
function countOf (count: number, singular: string): string {
  return formatCount(count, singular).replace(String(count), count.toLocaleString())
}

/** How the retention outcome is spelled, so 0 does not announce as a duration. */
function describeRetention (days: number): string {
  if (days === SCROLL_CACHE_TTL_MIN_DAYS) return 'Scroll cache retention disabled. Tiles are no longer removed by age.'
  return `Scroll cache retention set to ${formatCount(days, 'day')}.`
}

/** The chart counts, shared by the visible summary and its announcement. */
function describeChartCounts (valid: number, invalid: number): string {
  return `${countOf(valid, 'valid chart')}, ${invalid.toLocaleString()} invalid`
}

/** One condition's words, with the severity it is both shown and announced at. */
interface PanelMessage {
  text: string
  tone: BannerTone
}

function panelMessage (text: string, tone: BannerTone): PanelMessage {
  return { text, tone }
}

interface MessageBannerProps {
  message: PanelMessage | null
}

/** One banner, or nothing at all when the condition it reports does not hold. */
function MessageBanner ({ message }: MessageBannerProps): React.ReactElement | null {
  return message === null ? null : <Banner tone={message.tone}>{message.text}</Banner>
}

/** The banners stacked under the status bar, in the order they are shown. */
const TOP_BANNER_KEYS = [
  'statusUnavailable',
  'tileCacheUnconfigured',
  'diskPressure',
  'slowUpstream',
  'actionFailed',
  'actionStillRunning',
  'restartOnSave'
] as const

/**
 * Join the conditions that currently hold into one announcement, each ending in a full stop.
 *
 * Every active condition is carried rather than only the most severe, so a condition that arises
 * while another is already up is never dropped. An unchanged set produces an identical string, which
 * leaves the region's text untouched and announces nothing.
 */
function announce (...messages: Array<PanelMessage | null>): string {
  return messages
    .filter((message): message is PanelMessage => message !== null && message.text !== '')
    .map(({ text }) => (text.endsWith('.') ? text : `${text}.`))
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
  // The frame mounts its announcer before any message exists, which is the arrangement a screen
  // reader actually observes, and re-announces a repeated message on its own. A one-shot action
  // outcome therefore speaks through it rather than through a region this panel would have to mount
  // and blank beside the words it wants read.
  const announceOutcome = usePanelAnnouncer()
  const [saveRequestedAt, setSaveRequestedAt] = useState<number | null>(null)
  const [ttlDraft, setTtlDraft] = useState(SCROLL_CACHE_TTL_DEFAULT_DAYS)
  const [actionError, setActionError] = useState<string | null>(null)
  const [stillRunning, setStillRunning] = useState<string | null>(null)
  const [clearScrollConfirmation, setClearScrollConfirmation] = useState(false)
  const [pendingAction, setPendingAction] = useState<PanelAction | null>(null)
  const pendingActionRef = useRef<PanelAction | null>(null)
  const mountedRef = useRef(true)
  // Narrowed once for the whole cache section. A null check repeated in every row is a null check
  // the reader cannot tell has already been made.
  const stats = cache.stats

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
    const serverTtl = stats?.ttlDays
    if (serverTtl === undefined) return
    const lastServerTtl = lastServerTtlRef.current
    lastServerTtlRef.current = serverTtl
    setTtlDraft((current) => (lastServerTtl === null || current === lastServerTtl ? serverTtl : current))
  }, [stats?.ttlDays])

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

  // One pass over the field table per configuration change rather than one per render: the save bar
  // needs a count and the first failing field, and the Advanced header needs the count of its own.
  const { validation, invalidMessage, advancedProblems } = useMemo(() => {
    const fields = validatePanelConfig(state)
    let invalid = 0
    let advanced = 0
    let first: keyof PanelValidation | null = null
    for (const key of VALIDATED_FIELD_KEYS) {
      if (fields[key] === null) continue
      invalid += 1
      if (first === null) first = key
      if (VALIDATED_FIELDS[key].advanced) advanced += 1
    }
    // One sentence for one state. A single invalid field is named, because the operator has to be
    // able to find it; several are counted, because listing them all would outgrow the save bar.
    return {
      validation: fields,
      advancedProblems: advanced,
      invalidMessage: first === null
        ? null
        : invalid === 1
          ? `Fix ${describeField(first)} before saving.`
          : `Fix the ${invalid} highlighted configuration fields before saving.`
    }
  }, [state])
  const advancedInvalid = advancedProblems > 0
  const [advancedOpen, setAdvancedOpen] = useState(advancedInvalid)

  useEffect(() => {
    if (advancedInvalid) setAdvancedOpen(true)
  }, [advancedInvalid])

  // No dirty guard: state and requestedState are the same object while the panel is clean, so all
  // three identity comparisons already report no change.
  const restartChanges = useMemo(() => {
    const changes: string[] = []
    if (state.tileCache !== requestedState.tileCache) changes.push('tile-cache limits')
    if (state.charts !== requestedState.charts) changes.push('chart discovery')
    if (state.advanced !== requestedState.advanced) changes.push('container settings')
    return changes
  }, [state, requestedState])

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
    setStillRunning(null)
    Promise.resolve()
      .then(action)
      .then((result) => {
        if (mountedRef.current) onSuccess?.(result)
      })
      .catch((cause) => {
        if (!mountedRef.current) return
        // An expired budget on a write is not a failure: the route has the request and is still
        // working on it. Saying "failed" here would push the operator into running it a second time.
        if (isRequestTimeout(cause)) setStillRunning(describeStillRunning(key))
        else setActionError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        pendingActionRef.current = null
        if (mountedRef.current) setPendingAction(null)
      })
  }, [])

  /**
   * The busy-except-me rule, stated once: a control refuses while another action runs, and shows its
   * own loading state while it is the one running. Both read the key the button was given, so the
   * key cannot be spelled one way in the guard and another in the loading test.
   */
  const actionProps = (key: PanelAction): ActionProps => ({
    ariaDisabled: pendingAction !== null && pendingAction !== key,
    loading: pendingAction === key,
    loadingLabel: PANEL_ACTIONS[key].loadingLabel
  })
  const retentionAction = actionProps('retention')

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

  const handleSave = useCallback((): void => {
    // markSaveRequested returns the snapshot it recorded, so the configuration that reaches the
    // server and the one the dirty check compares against are one value with one owner.
    save(markSaveRequested())
    setSaveRequestedAt(Date.now())
    setSaveWasRequested(true)
  }, [save, markSaveRequested])

  const handleDiscard = useCallback((): void => {
    dispatch({ type: 'discard', config: requestedState })
  }, [dispatch, requestedState])

  const slowUpstream = useMemo(
    () => Object.values(stats?.upstream ?? {}).some((upstream) => upstream.slow),
    [stats]
  )
  const invalidChartCount = charts.discovery?.invalid.length ?? 0

  // Every banner's words and its severity in one place. A live region only announces text that
  // changes inside a region that already existed, so the banners below are visual surfaces with no
  // `live` of their own and the announcers at the top of the panel carry the words. Reading both
  // from this one table is what keeps the announcement and the banner from drifting apart, and
  // composing it once per change rather than once per render keeps a keystroke in a text field from
  // rebuilding every sentence on the page.
  const messages = useMemo(() => ({
    statusUnavailable: error === null
      ? null
      : panelMessage(`Status unavailable: ${error}. The next poll will retry automatically.`, 'danger'),
    diskPressure: stats?.diskPressure === true
      ? panelMessage('The cache filesystem is below its reserved free-space headroom. New tiles will be served without being cached.', 'danger')
      : null,
    actionFailed: actionError === null ? null : panelMessage(`Panel action failed: ${actionError}`, 'danger'),
    actionStillRunning: stillRunning === null ? null : panelMessage(stillRunning, 'info'),
    tileCacheUnconfigured: stats !== null && !stats.configured
      ? panelMessage('Tile cache is running but still waiting for its source and budget configuration.', 'warning')
      : null,
    slowUpstream: slowUpstream
      ? panelMessage('One or more chart sources are responding slowly. Chart Locker has increased their request timeout automatically.', 'warning')
      : null,
    cacheRefreshFailed: stats !== null && cache.error !== null
      ? panelMessage(`Cache statistics refresh failed: ${cache.error}. Showing the last successful result.`, 'warning')
      : null,
    externalCacheFallback: usingFallback
      ? panelMessage('The configured external cache path is unavailable, so free space is measured on the Signal K data filesystem.', 'warning')
      : null,
    cacheGuidanceUnavailable: cacheInfoError === null
      ? null
      : panelMessage(`Filesystem-specific cache guidance is unavailable: ${cacheInfoError}. The static cache limits remain available.`, 'warning'),
    capExceedsFreeSpace: freeGiB !== null && state.tileCache.cacheCapGiB > freeGiB
      ? panelMessage('Cache cap exceeds free space. Reduce it, or move the cache to an external drive under Advanced.', 'warning')
      : null,
    invalidCharts: invalidChartCount === 0
      ? null
      : panelMessage(`${countOf(invalidChartCount, 'chart file')} could not be read`, 'warning'),
    chartDiscoveryUnavailable: charts.error === null
      ? null
      : panelMessage(`Chart discovery unavailable: ${charts.error}`, 'warning'),
    restartOnSave: restartChanges.length === 0
      ? null
      : panelMessage(`Saving will reapply ${restartChanges.join(', ')} and may recreate the tile-cache container.`, 'info')
  }), [
    actionError,
    cache.error,
    cacheInfoError,
    charts.error,
    error,
    freeGiB,
    invalidChartCount,
    restartChanges,
    slowUpstream,
    state.tileCache.cacheCapGiB,
    stats,
    stillRunning,
    usingFallback
  ])

  const alertAnnouncement = useMemo(
    () => announce(messages.statusUnavailable, messages.diskPressure, messages.actionFailed),
    [messages.statusUnavailable, messages.diskPressure, messages.actionFailed]
  )
  const noticeAnnouncement = useMemo(() => announce(
    messages.tileCacheUnconfigured,
    messages.slowUpstream,
    messages.cacheRefreshFailed,
    messages.externalCacheFallback,
    messages.cacheGuidanceUnavailable,
    messages.capExceedsFreeSpace,
    messages.invalidCharts,
    messages.chartDiscoveryUnavailable,
    messages.restartOnSave,
    messages.actionStillRunning
  ), [
    messages.tileCacheUnconfigured,
    messages.slowUpstream,
    messages.cacheRefreshFailed,
    messages.externalCacheFallback,
    messages.cacheGuidanceUnavailable,
    messages.capExceedsFreeSpace,
    messages.invalidCharts,
    messages.chartDiscoveryUnavailable,
    messages.restartOnSave,
    messages.actionStillRunning
  ])

  // A scan that found nothing at all gets an orientation instead of a count of zero, because a
  // count of zero says nothing about where the files belong or what a chart file looks like. A
  // directory holding only unreadable files is not empty: the warning below explains that case.
  const chartsDirectoryEmpty = charts.discovery !== null &&
    charts.discovery.valid === 0 &&
    invalidChartCount === 0
  const chartsDirectory = state.charts.path === '' ? DEFAULT_CHARTS_SUBPATH : state.charts.path

  // One button, rendered either as the empty state's own next step or below the chart summary, so
  // the empty state can carry an action without putting a second identical button beside it.
  const rescanButton = (
    <Button
      {...actionProps('rescan-charts')}
      onClick={() => runAction('rescan-charts', charts.rescan, (result) => {
        announceOutcome(result === null
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
        * Two announcers, mounted for the panel's whole life and empty until they have something to
        * say. Interrupting conditions are separated from routine ones so a cleared cache never cuts
        * across a screen reader. A one-shot action outcome goes through the frame's own announcer
        * instead, so reporting it neither re-announces every ambient condition beside it nor needs
        * a region of its own.
        *
        * Each carries data-panel-announcer because the panel shell mounts announcers of its own, so
        * role alone no longer tells the panel's regions from the shell's.
        */}
      <LiveRegion
        data-panel-announcer='assertive'
        live='assertive'
        message={alertAnnouncement}
      />
      <LiveRegion
        data-panel-announcer='polite'
        live='polite'
        message={noticeAnnouncement}
      />

      <StatusBar status={status} lastUpdatedMs={lastUpdatedMs} />

      {TOP_BANNER_KEYS.map((key) => <MessageBanner key={key} message={messages[key]} />)}

      <Section title='Cache operations' description='Live usage, source health, retention, and maintenance controls.'>
        <Stack gap={3}>
          {stats === null
            ? (
              // One live status that stays mounted from the loading line through a failure, so the
              // failure text is announced as an update to a region that already existed.
              <StatusIndicator tone={cache.error === null ? 'neutral' : 'warning'} live='polite'>
                {cache.error === null ? 'Loading cache statistics...' : `Statistics unavailable: ${cache.error}`}
              </StatusIndicator>
              )
            : (
              <>
                <MessageBanner message={messages.cacheRefreshFailed} />
                <MetricGrid>
                  {([
                    ['Used', stats.bytes],
                    ['Capacity', stats.cap],
                    ['Saved regions', stats.pinnedBytes],
                    ['Scroll cache', stats.scrollBytes],
                    ['Region headroom', stats.regionsFreeBytes],
                    ['Filesystem free', stats.availableBytes]
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
                    {...retentionAction}
                    ariaDisabled={retentionAction.ariaDisabled || ttlDraft === stats.ttlDays}
                    onClick={() => runAction(
                      'retention',
                      () => cache.setTtlDays(ttlDraft),
                      () => announceOutcome(describeRetention(ttlDraft))
                    )}
                  >
                    Apply retention
                  </Button>
                  {/* Every action, not only its own: this opens a confirmation, and a confirmation
                      raised over work already running would ask about a state that is moving. */}
                  <Button
                    ariaDisabled={pendingAction !== null}
                    onClick={() => setClearScrollConfirmation(true)}
                  >
                    Clear scroll cache
                  </Button>
                  <Button
                    {...actionProps('refresh-cache')}
                    onClick={() => runAction(
                      'refresh-cache',
                      cache.refresh,
                      () => announceOutcome('Cache statistics refreshed.')
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
                    announceOutcome('Scroll cache cleared.')
                  })}
                />

                {/*
                  * The shared Table rather than DataGrid: the data-grid entry point pulls
                  * react-aria-components and react-stately into the remote, measured at 103 KiB gzip
                  * against a few KiB for this markup. The breakdown is bounded at 256 sources and is
                  * usually two or three, so nothing here needs sorting or virtualization.
                  */}
                {stats.bySource.length > 0
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
                          {stats.bySource.map((source) => {
                            const slow = stats.upstream[source.source]?.slow === true
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
                  Diagnostics: {stats.diagnostics.cacheOperationErrors} cache errors, {stats.diagnostics.diskPressureEvents} disk-pressure events, and {stats.diagnostics.warmRejections} rejected warm requests.
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
          <MessageBanner message={messages.externalCacheFallback} />
          <MessageBanner message={messages.cacheGuidanceUnavailable} />
          <MessageBanner message={messages.capExceedsFreeSpace} />
          <NumberField
            label={VALIDATED_FIELDS.regionsBudget.label}
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

      {/* Named for the suite that audits this subtree on its own: the section landmark is named by
          its heading, which no CSS selector can reach. */}
      <Section data-panel-section='charts' title='Charts' description='Local PMTiles charts served by the plugin.'>
        <Stack gap={3}>
          <LabeledField
            label={VALIDATED_FIELDS.chartsPath.label}
            layout='inline'
            error={validation.chartsPath}
            errorLive='polite'
            description={
              <>
                Directory holding .pmtiles charts, relative to the Signal K config path. Leave blank
                for the default {DEFAULT_CHARTS_SUBPATH}.
              </>
            }
          >
            <TextInput
              placeholder={DEFAULT_CHARTS_SUBPATH}
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
              <Banner tone={messages.invalidCharts.tone} title={messages.invalidCharts.text}>
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
          <MessageBanner message={messages.chartDiscoveryUnavailable} />
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
          ? <Badge tone='danger'>{formatCount(advancedProblems, 'problem')}</Badge>
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
            label={VALIDATED_FIELDS.imageTag.label}
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
              maxLength={MAX_IMAGE_TAG_LENGTH}
              value={state.advanced.imageTag}
              onChange={(event) => dispatch({ type: 'setImageTag', tag: event.target.value })}
            />
          </LabeledField>
          <LabeledField
            label={VALIDATED_FIELDS.cacheVolumeSource.label}
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
