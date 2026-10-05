/**
 * Root component of the federated configuration panel. The Signal K admin UI
 * loads it from remoteEntry.js and renders it in place of the generated
 * react-jsonschema-form, passing the current configuration and a
 * fire-and-forget save callback.
 */

import type * as React from 'react'
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  joinList,
  LabeledField,
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
  useResetDrafts,
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
import { UnitValue } from './components/UnitText.js'
import { PANEL_AGE_TICK_MS } from './age-tick.js'
import type { ConfigGroup } from './config-changes.js'
import { BYTE_UNITS, ONE_DECIMAL, splitBytes } from './format-bytes.js'
import { useConfig } from './hooks/use-config.js'
import { useStatus } from './hooks/use-status.js'
import { useCacheInfo } from './hooks/use-cache-info.js'
import { useCacheOperations } from './hooks/use-cache-operations.js'
import { type ChartDiscoveryState, useChartDiscovery } from './hooks/use-chart-discovery.js'
import { describeError, isRequestTimeout } from './hooks/use-abortable-fetch.js'
import {
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

/** How the restart notice names each configuration group a save reapplies. */
const RESTART_GROUP_NAMES: Readonly<Record<ConfigGroup, string>> = {
  tileCache: 'tile-cache limits',
  charts: 'chart discovery',
  advanced: 'container settings'
}

/** How many unreadable chart files the warning lists by name before it summarizes the rest. */
const MAX_LISTED_INVALID_CHARTS = 5

/** The invalid list before the first scan answers, one array so the warning's memo holds. */
const NO_INVALID_CHARTS: ChartDiscoveryState['invalid'] = []

type PanelAction = 'retention' | 'clear-scroll' | 'refresh-cache' | 'rescan-charts'

/**
 * How each action reads while it runs: the phrase the still-running, failed, and blocked sentences
 * use, and the label the button that starts it shows. Clearing the scroll cache carries no button
 * label, because its inline confirmation owns the busy state rather than the trigger beside it.
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
  disabledReason: string | undefined
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

/** What the panel says when a maintenance action's request is refused, naming the action. */
function describeActionFailure (action: PanelAction, cause: unknown): string {
  const { inProgress } = PANEL_ACTIONS[action]
  return `${inProgress.charAt(0).toUpperCase()}${inProgress.slice(1)} failed: ${describeError(cause)}. Try again.`
}

/**
 * Why a control refuses while another action runs. A keyboard operator who lands on it hears what
 * it is waiting for, and the running button's own busy label says the rest.
 */
function describeBusy (action: PanelAction): string {
  return `Available when Chart Locker finishes ${PANEL_ACTIONS[action].inProgress}.`
}

/** How the retention outcome is spelled, so 0 does not announce as a duration. */
function describeRetention (days: number): string {
  if (days === SCROLL_CACHE_TTL_MIN_DAYS) return 'Scroll cache retention disabled. Tiles are no longer removed by age.'
  return `Scroll cache retention set to ${formatCount(days, 'day')}.`
}

/** Why Apply retention refuses while the box holds the retention already in force. */
function describeRetentionUnchanged (days: number): string {
  if (days === SCROLL_CACHE_TTL_MIN_DAYS) return 'Age-based removal is already off. Enter a number of days to turn it on.'
  return `Retention is already ${formatCount(days, 'day')}. Enter a different number to change it.`
}

/**
 * The chart counts, shared by the visible summary and its announcement. The second count reads as
 * an adjective, so its plural is its singular.
 */
function describeChartCounts (valid: number, invalid: number): string {
  return `${formatCount(valid, 'valid chart')}, ${formatCount(invalid, 'invalid', 'invalid')}`
}

/**
 * Every condition the panel reports in a banner, with the severity it is shown and announced at.
 * The severity belongs to the slot rather than to the words, because a live region keeps one role
 * for its whole life: a danger banner interrupts, and the rest wait for a pause in speech.
 */
const BANNER_TONES = {
  statusUnavailable: 'danger',
  diskPressure: 'danger',
  actionFailed: 'danger',
  tileCacheUnconfigured: 'warning',
  slowUpstream: 'warning',
  cacheRefreshFailed: 'warning',
  externalCacheFallback: 'warning',
  cacheGuidanceUnavailable: 'warning',
  capExceedsFreeSpace: 'warning',
  invalidCharts: 'warning',
  chartDiscoveryUnavailable: 'warning',
  actionStillRunning: 'info',
  restartOnSave: 'info'
} as const satisfies Record<string, BannerTone>

type BannerSlot = keyof typeof BANNER_TONES

/** The banners stacked under the status bar, in the order they are shown. */
const TOP_BANNER_SLOTS = [
  'statusUnavailable',
  'tileCacheUnconfigured',
  'diskPressure',
  'slowUpstream',
  'actionFailed',
  'actionStillRunning',
  'restartOnSave'
] as const satisfies readonly BannerSlot[]

interface MessageBannerProps {
  slot: BannerSlot
  /** The condition's words, or null while it does not hold. */
  text: string | null
  /** Detail under the words, which then head the banner as its title. */
  details?: React.ReactNode
}

/**
 * One condition's banner, mounted for the panel's whole life and empty while the condition does not
 * hold. A screen reader announces text that changes inside a region that already existed, and an
 * empty announcing banner leaves the flow, so it costs nothing on screen while it waits.
 *
 * Each carries data-panel-banner, because a banner with nothing to say has no text or name for a
 * test to find it by. Memoized, because the banners stay mounted and an edit elsewhere in the panel
 * changes none of their props.
 */
const MessageBanner = memo(function MessageBanner ({ slot, text, details }: MessageBannerProps): React.ReactElement {
  const tone = BANNER_TONES[slot]
  const live = tone === 'danger' ? 'assertive' : 'polite'
  if (details === undefined) {
    return <Banner data-panel-banner={slot} tone={tone} live={live}>{text}</Banner>
  }
  return (
    <Banner data-panel-banner={slot} tone={tone} live={live} title={text}>
      {text === null ? null : details}
    </Banner>
  )
})

interface Props {
  /**
   * The plugin configuration supplied by the admin UI: undefined for a plugin nobody has configured,
   * and otherwise the saved object. Untyped at the federation boundary.
   */
  configuration: unknown
  /** Requests a configuration save. Fire-and-forget: it returns void and must not be awaited. */
  save: (configuration: unknown) => void
}

/**
 * The configuration panel rendered inside the Signal K admin UI. The shell runs the browser
 * preflight, owns the theme toggle, and catches a render error inside the body so the operator gets
 * a retry and a page reload in place instead of the Admin host's generic unavailable notice.
 */
export default function PluginConfigurationPanel (props: Props): React.ReactElement {
  return (
    <PanelShell themeToggle='end'>
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
  const {
    draft,
    pending,
    saved,
    changes,
    unconfigured,
    dispatch,
    discard
  } = useConfig(configuration, recommendedCapGiB)
  const resetDrafts = useResetDrafts()
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

  const dirty = changes.length > 0

  // One pass over the field table per configuration change rather than one per render: the save bar
  // needs a count and the first failing field, and the Advanced header needs the count of its own.
  // The normalized buffer is what is validated, because it is the text a save sends and the plugin
  // reads, surrounding spaces already gone.
  const { validation, invalidMessage, advancedProblems } = useMemo(() => {
    const fields = validatePanelConfig(pending)
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
  }, [pending])
  const advancedInvalid = advancedProblems > 0
  const [advancedOpen, setAdvancedOpen] = useState(advancedInvalid)

  useEffect(() => {
    if (advancedInvalid) setAdvancedOpen(true)
  }, [advancedInvalid])

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
        else setActionError(describeActionFailure(key, cause))
      })
      .finally(() => {
        pendingActionRef.current = null
        if (mountedRef.current) setPendingAction(null)
      })
  }, [])

  /**
   * The busy-except-me rule, stated once: a control refuses while another action runs, says what it
   * is waiting for, and shows its own loading state while it is the one running. All three read the
   * key the button was given, so the key cannot be spelled one way in the guard and another in the
   * loading test. A control with a refusal of its own passes the reason, and another action's run
   * still speaks first, because it is what has to end before that reason matters.
   */
  const busyReason = pendingAction === null ? undefined : describeBusy(pendingAction)
  const actionProps = (key: PanelAction, blockedReason?: string): ActionProps => {
    const busy = pendingAction !== null && pendingAction !== key
    return {
      ariaDisabled: busy || blockedReason !== undefined,
      disabledReason: busy ? busyReason : blockedReason ?? busyReason,
      loading: pendingAction === key,
      loadingLabel: PANEL_ACTIONS[key].loadingLabel
    }
  }

  // Warn before a tab close or reload while edits are unsaved.
  useUnsavedChangesGuard(dirty)

  const handleSave = useCallback((): void => {
    // The normalized buffer goes to the host, which hands it straight back as `configuration`, so
    // the comparison the save bar reads is clean again on the next render.
    setSaveRequestedAt(Date.now())
    save(pending)
  }, [save, pending])

  const handleDiscard = useCallback((): void => {
    discard()
    // A number box mid-edit keeps its own draft text; this drops it so the box shows the restored value.
    resetDrafts()
  }, [discard, resetDrafts])

  const slowUpstream = useMemo(
    () => Object.values(stats?.upstream ?? {}).some((upstream) => upstream.slow),
    [stats]
  )
  const invalidCharts = charts.discovery?.invalid ?? NO_INVALID_CHARTS
  const invalidChartCount = invalidCharts.length
  // Built once per scan result, so the memoized warning banner skips the renders an edit causes.
  const invalidChartDetails = useMemo(() => (
    <>
      {/* Stack wraps each child in its own list item, so these are bare fragments. */}
      <Stack as='ul' gap={1}>
        {invalidCharts.slice(0, MAX_LISTED_INVALID_CHARTS).map((item) => (
          <Fragment key={item.fileName}><Code>{item.fileName}</Code>: {item.error}</Fragment>
        ))}
      </Stack>
      {invalidChartCount > MAX_LISTED_INVALID_CHARTS
        ? (
          <Text as='p' size='sm'>
            {formatCount(invalidChartCount - MAX_LISTED_INVALID_CHARTS, 'more file')} not listed.
          </Text>
          )
        : null}
    </>
  ), [invalidCharts, invalidChartCount])

  // Every banner's words in one place, null while its condition does not hold. Composing them once
  // per change rather than once per render keeps a keystroke in a text field from rebuilding every
  // sentence on the page.
  const texts = useMemo((): Readonly<Record<BannerSlot, string | null>> => ({
    statusUnavailable: error === null
      ? null
      : `Status unavailable: ${error}. The next poll will retry automatically.`,
    diskPressure: stats?.diskPressure === true
      ? 'The cache filesystem is below its reserved free-space headroom. New tiles will be served without being cached.'
      : null,
    actionFailed: actionError,
    actionStillRunning: stillRunning,
    tileCacheUnconfigured: stats !== null && !stats.configured
      ? 'Tile cache is running but still waiting for its source and budget configuration.'
      : null,
    slowUpstream: slowUpstream
      ? 'One or more chart sources are responding slowly. Chart Locker has increased their request timeout automatically.'
      : null,
    cacheRefreshFailed: stats !== null && cache.error !== null
      ? `Cache statistics refresh failed: ${cache.error}. Showing the last successful result.`
      : null,
    externalCacheFallback: usingFallback
      ? 'The configured external tile cache drive is unavailable, so free space is measured on the Signal K data filesystem.'
      : null,
    cacheGuidanceUnavailable: cacheInfoError === null
      ? null
      : `Filesystem-specific cache guidance is unavailable: ${cacheInfoError}. The static cache limits remain available.`,
    capExceedsFreeSpace: freeGiB !== null && pending.tileCache.cacheCapGiB > freeGiB
      ? 'Cache cap exceeds free space. Reduce it, or move the cache to an external drive under Advanced.'
      : null,
    invalidCharts: invalidChartCount === 0
      ? null
      : `${formatCount(invalidChartCount, 'chart file')} could not be read`,
    chartDiscoveryUnavailable: charts.error === null
      ? null
      : `Chart discovery unavailable: ${charts.error}. Rescan charts to try again.`,
    restartOnSave: changes.length === 0
      ? null
      : `Saving will reapply ${joinList(changes.map((group) => RESTART_GROUP_NAMES[group]))} and may recreate the tile-cache container.`
  }), [
    actionError,
    cache.error,
    cacheInfoError,
    changes,
    charts.error,
    error,
    freeGiB,
    invalidChartCount,
    pending.tileCache.cacheCapGiB,
    slowUpstream,
    stats,
    stillRunning,
    usingFallback
  ])

  // A scan that found nothing at all gets an orientation instead of a count of zero, because a
  // count of zero says nothing about where the files belong or what a chart file looks like. A
  // directory holding only unreadable files is not empty: the warning below explains that case.
  const chartsDirectoryEmpty = charts.discovery !== null &&
    charts.discovery.valid === 0 &&
    invalidChartCount === 0
  // The directory the last scan read, which is the saved one rather than an edit not yet saved.
  const chartsDirectory = saved.charts.path === '' ? DEFAULT_CHARTS_SUBPATH : saved.charts.path

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
      <StatusBar status={status} lastUpdatedMs={lastUpdatedMs} />

      {TOP_BANNER_SLOTS.map((slot) => <MessageBanner key={slot} slot={slot} text={texts[slot]} />)}

      <Section title='Cache operations' description='Live usage, source health, retention, and maintenance controls.'>
        <Stack gap={3}>
          {stats === null
            ? (
              // One live status that stays mounted from the loading line through a failure, so the
              // failure text is announced as an update to a region that already existed. The loading
              // line it mounts with is not news, so it shows at once.
              <StatusIndicator
                tone={cache.error === null ? 'neutral' : 'warning'}
                live='polite'
                deferFirstMessage={false}
              >
                {cache.error === null
                  ? 'Loading cache statistics…'
                  : `Cache statistics unavailable: ${cache.error}. The next poll will retry automatically.`}
              </StatusIndicator>
              )
            : (
              <>
                <MessageBanner slot='cacheRefreshFailed' text={texts.cacheRefreshFailed} />
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
                  // A box sized for the few digits it holds, the width the cap's exact-value box
                  // already takes, rather than one stretched across the row as if for a path.
                  controlWidth='fixed'
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
                    {...actionProps(
                      'retention',
                      ttlDraft === stats.ttlDays ? describeRetentionUnchanged(stats.ttlDays) : undefined
                    )}
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
                    disabledReason={busyReason}
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
                                <TableCell numeric><UnitValue {...splitBytes(source.bytes)} /></TableCell>
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
                  Diagnostics: {formatCount(stats.diagnostics.cacheOperationErrors, 'cache error')}, {formatCount(stats.diagnostics.diskPressureEvents, 'disk-pressure event')}, and {formatCount(stats.diagnostics.warmRejections, 'rejected warm request')}.
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
            unit={BYTE_UNITS.GiB}
            value={draft.tileCache.cacheCapGiB}
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
            ? (
              <Text as='p' tone='muted' size='sm'>
                <UnitValue tone='muted' size='sm' value={ONE_DECIMAL.format(freeGiB)} unit={BYTE_UNITS.GiB} /> free on the {storage === 'external' ? 'external cache filesystem' : 'Signal K data filesystem'}.
              </Text>
              )
            : null}
          <MessageBanner slot='externalCacheFallback' text={texts.externalCacheFallback} />
          <MessageBanner slot='cacheGuidanceUnavailable' text={texts.cacheGuidanceUnavailable} />
          <MessageBanner slot='capExceedsFreeSpace' text={texts.capExceedsFreeSpace} />
          <NumberField
            label={VALIDATED_FIELDS.regionsBudget.label}
            unit={BYTE_UNITS.GiB}
            controlWidth='fixed'
            layout='inline'
            min={REGIONS_BUDGET_MIN_GIB}
            integer
            fallback={REGIONS_BUDGET_DEFAULT_GIB}
            value={draft.tileCache.regionsBudgetGiB}
            onValueChange={(giB) => dispatch({ type: 'setRegionsBudgetGiB', giB })}
            error={validation.regionsBudget}
            errorLive='polite'
            description={
              <>
                A ceiling on how much of the cache saved regions may pin. Leave 0 to reserve half the
                cache cap. This is not space taken from the scroll cache until a region is actually
                saved. Keep it no higher than the cache cap.
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
              value={draft.charts.path}
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
                {describeChartCounts(charts.discovery.valid, invalidChartCount)}.{' '}
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
          <MessageBanner slot='invalidCharts' text={texts.invalidCharts} details={invalidChartDetails} />
          <MessageBanner slot='chartDiscoveryUnavailable' text={texts.chartDiscoveryUnavailable} />
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
            checked={draft.advanced.geocodingEnabled}
            description={
              <>
                Allow Chart Locker to name a saved region from its coordinates using OpenStreetMap
                Nominatim. Turn this off to prevent that outbound request.
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
              value={draft.advanced.imageTag}
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
              value={draft.advanced.cacheVolumeSource}
              onChange={(event) => dispatch({ type: 'setCacheVolumeSource', path: event.target.value })}
            />
          </LabeledField>
        </Stack>
      </CollapsibleSection>

      <SaveActionBar
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
