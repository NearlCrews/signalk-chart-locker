/**
 * Root component of the federated configuration panel. The Signal K admin UI
 * loads it from remoteEntry.js and renders it in place of the generated
 * react-jsonschema-form, passing the current configuration and a
 * fire-and-forget save callback.
 *
 * The panel is laid out in five zones: the theme control bar, the live status
 * bar, the Tile cache section, the Charts section, and the collapsed Advanced
 * disclosure, over a sticky footer. The zones mirror the plugin's schema
 * groups so the panel and the plain schema form present the same structure.
 */

import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import StatusBar from './components/StatusBar.js'
import Banner from './components/Banner.js'
import Section from './components/Section.js'
import Disclosure from './components/Disclosure.js'
import RangeField from './components/RangeField.js'
import NumberField from './components/NumberField.js'
import TextField from './components/TextField.js'
import FooterBar from './components/FooterBar.js'
import ThemeToggle from './components/ThemeToggle.js'
import { useConfig } from './hooks/use-config.js'
import { useStatus } from './hooks/use-status.js'
import { useCacheInfo } from './hooks/use-cache-info.js'
import { useTheme } from './hooks/use-theme.js'
import {
  CACHE_CAP_DEFAULT_GIB,
  CACHE_CAP_MAX_GIB,
  CACHE_CAP_MIN_GIB,
  CACHE_CAP_STEP_GIB,
  REGIONS_BUDGET_DEFAULT_GIB,
  REGIONS_BUDGET_MIN_GIB
} from './config-types.js'
import { S, THEME_STYLE } from './styles.js'

/** How long, in milliseconds, the "Saved" confirmation pill stays visible. */
const SAVED_PILL_MS = 2500

interface Props {
  /** The plugin configuration supplied by the admin UI. Untyped at the federation boundary. */
  configuration: unknown
  /** Persists the configuration. Fire-and-forget: it returns void and must not be awaited. */
  save: (configuration: unknown) => void
}

/** The configuration panel rendered inside the Signal K admin UI. */
export default function PluginConfigurationPanel ({ configuration, save }: Props): React.ReactElement {
  const { status, error, lastUpdatedMs } = useStatus()
  const { freeGiB, recommendedCapGiB } = useCacheInfo()
  const { state, savedState, dispatch, markSaved, reseed } = useConfig(configuration)
  const [theme, setTheme] = useTheme()
  const [justSavedAt, setJustSavedAt] = useState<number | null>(null)
  // Whether the plugin has ever been saved. Seeded from the mount prop (the admin UI passes null or
  // undefined for a never-configured plugin) and flipped on the first save, because the admin UI does
  // not re-pass configuration after a save, so a value derived purely from the prop would stay
  // never-configured forever.
  const [everSaved, setEverSaved] = useState(configuration != null)

  // Clear the "Saved" pill a short while after a save.
  useEffect(() => {
    if (justSavedAt === null) return
    const timeoutId = setTimeout(() => setJustSavedAt(null), SAVED_PILL_MS)
    return () => clearTimeout(timeoutId)
  }, [justSavedAt])

  // Every reducer case returns a new object only on a real change, so identity
  // inequality against the last-saved snapshot is a sound dirty check.
  const dirty = state !== savedState

  // Save must stay enabled while the plugin has never been saved, so the user can persist defaults to
  // enable the plugin without making a throwaway edit first.
  const unconfigured = !everSaved

  // Warn before a tab close or reload while edits are unsaved, so a
  // fat-fingered close cannot silently lose in-progress configuration.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      // Chrome ignores preventDefault alone; setting returnValue is what
      // actually triggers its leave-confirmation dialog.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Seed the cache cap from detected free space, once, for a never-configured plugin. It runs only
  // while the field still holds the static default and nothing is dirty, so it never clobbers a
  // stored value or an edit the user made while the cache-info fetch was in flight. reseed sets the
  // saved snapshot too, so the seeded default is not counted as an unsaved change.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    if (!unconfigured || dirty) return
    if (recommendedCapGiB === null) return
    if (state.tileCache.cacheCapGiB !== CACHE_CAP_DEFAULT_GIB) return
    seededRef.current = true
    reseed({ ...state, tileCache: { ...state.tileCache, cacheCapGiB: recommendedCapGiB } })
  }, [unconfigured, dirty, recommendedCapGiB, state, reseed])

  // handleSave reads the latest state through a ref so its identity does not
  // change per keystroke; that keeps the memoized FooterBar from re-rendering
  // until the dirty flag actually flips.
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

  return (
    <div
      className='cl-config-panel'
      data-cl-theme={theme === 'auto' ? undefined : theme}
      style={S.root}
    >
      <style>{THEME_STYLE}</style>
      <div style={S.controlBar}>
        <ThemeToggle value={theme} onChange={setTheme} />
      </div>
      <StatusBar status={status} lastUpdatedMs={lastUpdatedMs} />
      {error !== null
        ? <Banner variant='danger'>Status unavailable: {error}. The next poll will retry automatically.</Banner>
        : null}

      <Section
        title='Tile cache'
        description='The on-disk cache for map tiles, plus the budget reserved for saved regions you keep for offline use.'
      >
        <RangeField
          id='cl-cache-cap'
          label='Cache size cap (GiB)'
          min={CACHE_CAP_MIN_GIB}
          max={CACHE_CAP_MAX_GIB}
          step={CACHE_CAP_STEP_GIB}
          value={state.tileCache.cacheCapGiB}
          onChange={(giB) => dispatch({ type: 'setCacheCapGiB', giB })}
          hint={
            <>
              The most disk space the tile cache may use. When it reaches this size it evicts the
              least recently used unpinned tiles to stay under the cap. Do not set this to all of
              your free space: the cache grows to fill the cap, and a full disk can stop the server
              from writing. If you move the cache to an external drive under Advanced, this value
              reflects the data directory filesystem, not the drive.
            </>
          }
        />
        {freeGiB !== null
          ? <p style={S.hintBelow}>{freeGiB} GiB free on the Signal K data directory.</p>
          : null}
        {freeGiB !== null && state.tileCache.cacheCapGiB > freeGiB
          ? (
            <Banner variant='warn'>
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
          hint={
            <>
              A ceiling on how much of the cache saved regions may pin. Leave 0 to reserve half the
              cache cap. This is not space taken from the scroll cache until a region is actually
              saved. A value above the cache cap is clamped to the cap.
            </>
          }
        />
      </Section>

      <Section
        title='Charts'
        description='Local PMTiles charts served by the plugin.'
      >
        <TextField
          id='cl-charts-path'
          label='PMTiles charts directory'
          placeholder='charts/pmtiles'
          value={state.charts.path}
          onChange={(path) => dispatch({ type: 'setChartsPath', path })}
          hint={
            <>
              Directory holding .pmtiles charts, relative to the Signal K config path. Leave blank
              for the default charts/pmtiles.
            </>
          }
        />
      </Section>

      <Disclosure summary='Advanced'>
        <p style={S.hintBelow}>Settings most installs never change.</p>
        <TextField
          id='cl-image-tag'
          label='Tile cache container image tag'
          placeholder='Pinned to the plugin version'
          value={state.advanced.imageTag}
          onChange={(tag) => dispatch({ type: 'setImageTag', tag })}
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
          hint={
            <>
              Host path of a USB SSD or NVMe drive to hold the tile cache. Leave blank to keep the
              cache on the Signal K data directory.
            </>
          }
        />
      </Disclosure>

      <FooterBar
        dirty={dirty}
        unconfigured={unconfigured}
        justSavedAt={justSavedAt}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
    </div>
  )
}
