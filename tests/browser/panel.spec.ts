import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The expected UI package version comes from the manifest, not a literal, so a bump edits one place
// and this assertion still proves the bundle carries what the manifest pins. The installed version is
// read from the file because the package's exports map does not expose its package.json for import.
function readManifestPin (): string {
  const manifest: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const pinned = (manifest as { devDependencies?: Record<string, string> })
    .devDependencies?.['signalk-nearlcrews-ui']
  if (pinned === undefined) throw new Error('package.json does not pin signalk-nearlcrews-ui')
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(`signalk-nearlcrews-ui must be pinned to an exact version, found ${pinned}`)
  }
  return pinned
}
const snuiPackage: unknown = JSON.parse(
  readFileSync(resolve('node_modules/signalk-nearlcrews-ui/package.json'), 'utf8')
)
if (typeof snuiPackage !== 'object' || snuiPackage === null ||
    !('version' in snuiPackage) || typeof snuiPackage.version !== 'string') {
  throw new Error('signalk-nearlcrews-ui package.json carries no version string')
}
const snuiVersion = snuiPackage.version
const expectedSnuiVersion = readManifestPin()
if (snuiVersion !== expectedSnuiVersion) {
  throw new Error(`expected signalk-nearlcrews-ui ${expectedSnuiVersion}, found ${snuiVersion}`)
}

// The theme storage key, taken from the package's public entry rather than a deep dist path, so a
// dist reshuffle in a future release cannot break this suite for a non-behavioral reason. The spec is
// transformed to CommonJS and the package is ESM only, so the value is read through a child process
// that imports the public entry point.
function readThemeStorageKey (): string {
  const key = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "import { THEME_STORAGE_KEY } from 'signalk-nearlcrews-ui'; process.stdout.write(THEME_STORAGE_KEY)"],
    { cwd: resolve('.'), encoding: 'utf8' }
  ).trim()
  if (key === '') throw new Error('THEME_STORAGE_KEY resolved empty from the signalk-nearlcrews-ui entry point')
  return key
}
const themeStorageKey = readThemeStorageKey()

async function expectVisibleFocusRing (control: Locator): Promise<void> {
  const outline = await control.evaluate((element) => {
    const style = getComputedStyle(element)
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
  })
  expect(outline.style).toBe('solid')
  expect(outline.width).toBeGreaterThanOrEqual(2)
}

async function releaseFixtureAction (page: Page, action: string): Promise<void> {
  await page.evaluate((actionName) => {
    const release = Reflect.get(window, 'releaseFixtureAction')
    if (typeof release !== 'function') throw new Error('Fixture action release function is unavailable.')
    release(actionName)
  }, action)
}

async function holdNextFixtureAction (page: Page, action: string): Promise<void> {
  await page.evaluate((actionName) => {
    const hold = Reflect.get(window, 'holdFixtureAction')
    if (typeof hold !== 'function') throw new Error('Fixture action hold function is unavailable.')
    hold(actionName)
  }, action)
}

/**
 * Writes the shared theme key the way another document would, then waits for the panel to commit
 * whatever the resulting storage event produced. Without the wait, asserting that a theme stayed
 * put would pass while a reset was still pending.
 */
async function writeSharedThemeFromAnotherDocument (page: Page, value: string | null): Promise<void> {
  await page.evaluate(({ key, newValue }) => {
    if (newValue === null) localStorage.removeItem(key)
    else localStorage.setItem(key, newValue)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }))
  }, { key: themeStorageKey, newValue: value })
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByRole('heading', { name: 'Plugin status' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')
})

test('loads the production remote and completes save and discard flows', async ({ page }) => {
  const root = page.locator('[data-snui-root]')
  await expect(root).toHaveAttribute('data-snui-version', snuiVersion)
  await expect(page.locator(`style[data-snui-styles="${snuiVersion}"]`)).toHaveCount(1)
  await expect(page.getByRole('slider', { name: 'Cache size cap (GiB)' })).toHaveAttribute('id', 'cl-cache-cap')
  await expect(page.getByRole('spinbutton', { name: 'Cache size cap (GiB) exact value' })).toHaveAttribute('id', 'cl-cache-cap-number')

  const chartsPath = page.getByRole('textbox', { name: 'PMTiles charts directory' })
  const saveButton = page.getByRole('button', { name: 'Save', exact: true })
  const discardButton = page.getByRole('button', { name: 'Discard', exact: true })
  await expect(saveButton).toBeDisabled()
  await expect(discardButton).toBeDisabled()

  await chartsPath.fill('/charts/outside-config')
  const chartsPathError = page.getByText(
    'The PMTiles charts directory must stay relative to the Signal K configuration directory.',
    { exact: true }
  )
  await expect(chartsPathError).toBeVisible()
  const chartsPathErrorId = await chartsPathError.getAttribute('id')
  expect(chartsPathErrorId).not.toBeNull()
  await expect(chartsPath).toHaveAttribute('aria-invalid', 'true')
  await expect(chartsPath).toHaveAttribute('aria-errormessage', chartsPathErrorId!)
  await expect(saveButton).toBeDisabled()

  await chartsPath.fill('charts/new')
  await expect(chartsPath).not.toHaveAttribute('aria-invalid')
  await expect(chartsPathError).toHaveCount(0)
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await expect(saveButton).toBeEnabled()
  const actionStatus = page.locator('[data-panel-action-bar] [tabindex="-1"]')
  await saveButton.click()

  // Check the transient request acknowledgement before slower serialization
  // assertions so a busy cross-browser run cannot outlive its display timer.
  await expect(actionStatus).toBeFocused()
  await expect(actionStatus).toContainText('Save requested')
  await expect(page.locator('body')).toHaveAttribute('data-save-count', '1')
  await expect(page.locator('body')).toHaveAttribute('data-saved-configuration', /charts\/new/)
  const savedConfiguration = JSON.parse(
    await page.locator('body').getAttribute('data-saved-configuration') ?? '{}'
  )
  expect(savedConfiguration.futurePluginSetting).toEqual({ enabled: true, strategy: 'coastal' })
  expect(savedConfiguration.charts.futureChartSetting).toBe('keep-me')
  await expect(saveButton).toBeDisabled()

  await chartsPath.fill('charts/discard-me')
  await discardButton.click()
  await expect(chartsPath).toHaveValue('charts/new')
  await expect(actionStatus).toBeFocused()
  await expect(page.locator('body')).toHaveAttribute('data-save-count', '1')
})

test('breaks cache usage down per chart source', async ({ page }) => {
  const usage = page.getByRole('region', { name: 'Cache usage by chart source' })
  await expect(usage.getByRole('columnheader')).toHaveText(['Source', 'Usage', 'Tiles', 'Upstream'])

  const openstreetmap = usage.getByRole('row', { name: /openstreetmap/ })
  await expect(openstreetmap).toContainText('300.0 MiB')
  await expect(openstreetmap).toContainText('1,800')
  await expect(openstreetmap).toContainText('Normal')
  await expect(usage.getByRole('row', { name: /noaa/ })).toContainText('100.0 MiB')
})

test('opens Advanced when a stored setting is invalid', async ({ page }) => {
  await page.goto('/?invalid-advanced')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')

  const advanced = page.getByRole('button', { name: 'Advanced', exact: true })
  const imageTag = page.getByRole('textbox', { name: 'Tile cache container image tag' })
  await expect(advanced).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('The container image tag is not a valid OCI tag.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect(imageTag).toHaveAttribute('aria-invalid', 'true')

  await imageTag.fill('test-build')
  await expect(imageTag).not.toHaveAttribute('aria-invalid')
  await expect(imageTag).toBeFocused()
  await expect(advanced).toHaveAttribute('aria-expanded', 'true')
})

test('saves the optional reverse geocoding preference', async ({ page }) => {
  const advanced = page.getByRole('button', { name: 'Advanced', exact: true })
  await advanced.click()
  await expect(advanced).toHaveAttribute('aria-expanded', 'true')

  const geocoding = page.getByRole('checkbox', { name: 'Enable reverse geocoding' })
  await expect(geocoding).toBeChecked()
  await geocoding.uncheck()
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.locator('body')).toHaveAttribute('data-saved-configuration', /"geocodingEnabled":false/)
})

test('uses an inline confirmation for destructive cache clearing', async ({ page }) => {
  const clearButton = page.getByRole('button', { name: 'Clear scroll cache', exact: true }).first()
  await clearButton.click()
  const confirmation = page.getByRole('region', { name: 'Clear scroll cache?' })
  await expect(confirmation).toBeVisible()
  // Since signalk-nearlcrews-ui 0.5.0, the labelled confirmation container takes focus on open so
  // the message is announced; the Cancel and Confirm actions follow in the tab order.
  await expect(confirmation).toBeFocused()

  const cancelButton = confirmation.getByRole('button', { name: 'Cancel' })
  await cancelButton.click()
  await expect(clearButton).toBeFocused()
  await expect(page.locator('body')).not.toHaveAttribute('data-clear-request-count')

  await clearButton.click()
  await page.keyboard.press('Tab')
  await expect(cancelButton).toBeFocused()
  await page.keyboard.press('Tab')
  const confirmButton = confirmation.getByRole('button', { name: 'Clear scroll cache', exact: true })
  await expect(confirmButton).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('body')).toHaveAttribute('data-clear-request-count', '1')
  await expect(page.getByRole('heading', { name: 'Clear scroll cache?' })).toHaveCount(0)
  await expect(clearButton).toBeFocused()
})

test('runs cache and chart actions with stable focus, loading state, and repeat suppression', async ({ page }) => {
  await page.goto('/?hold-actions')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')

  const body = page.locator('body')
  const retention = page.getByRole('spinbutton', { name: 'Scroll cache retention (days)' })
  const apply = page.getByRole('button', { name: /Apply retention/ })
  const refresh = page.getByRole('button', { name: /Refresh/ })
  const rescan = page.getByRole('button', { name: /Rescan charts/ })

  await retention.fill('31')
  await apply.click()
  await expect(body).toHaveAttribute('data-fixture-pending-action', 'retention')
  await expect(apply).toHaveAttribute('aria-busy', 'true')
  await expect(apply).toBeFocused()
  await expect(apply).not.toHaveAttribute('disabled')
  await expect(refresh).toHaveAttribute('aria-disabled', 'true')
  await apply.evaluate((element) => {
    (element as HTMLButtonElement).click()
    ;(element as HTMLButtonElement).click()
  })
  await expect(body).toHaveAttribute('data-retention-request-count', '1')
  await releaseFixtureAction(page, 'retention')
  await expect(apply).not.toHaveAttribute('aria-busy')
  await expect(apply).toHaveAttribute('aria-disabled', 'true')
  await expect(apply).toBeFocused()

  const statsRequestsBeforeRefresh = Number(await body.getAttribute('data-cache-stats-request-count'))
  await holdNextFixtureAction(page, 'refresh')
  await refresh.click()
  await expect(body).toHaveAttribute('data-fixture-pending-action', 'refresh')
  await expect(refresh).toHaveAttribute('aria-busy', 'true')
  await expect(refresh).toBeFocused()
  await refresh.evaluate((element) => {
    (element as HTMLButtonElement).click()
    ;(element as HTMLButtonElement).click()
  })
  await expect(body).toHaveAttribute('data-cache-stats-request-count', String(statsRequestsBeforeRefresh + 1))
  await releaseFixtureAction(page, 'refresh')
  await expect(refresh).not.toHaveAttribute('aria-busy')
  await expect(refresh).toBeFocused()

  const clear = page.getByRole('button', { name: 'Clear scroll cache', exact: true }).first()
  await clear.click()
  const confirmation = page.getByRole('region', { name: 'Clear scroll cache?' })
  const confirmClear = confirmation.getByRole('button', { name: /Clear scroll cache/ })
  await expect(confirmation).toBeFocused()

  await rescan.click()
  await expect(body).toHaveAttribute('data-fixture-pending-action', 'rescan')
  await expect(rescan).toHaveAttribute('aria-busy', 'true')
  await expect(rescan).toBeFocused()
  await expect(confirmClear).toHaveAttribute('aria-disabled', 'true')
  await expect(confirmClear).toHaveAttribute('aria-busy', 'true')
  await confirmClear.evaluate((element) => (element as HTMLButtonElement).click())
  await expect(body).not.toHaveAttribute('data-clear-request-count')
  await rescan.evaluate((element) => {
    (element as HTMLButtonElement).click()
    ;(element as HTMLButtonElement).click()
  })
  await expect(body).toHaveAttribute('data-rescan-request-count', '1')
  await releaseFixtureAction(page, 'rescan')
  await expect(rescan).not.toHaveAttribute('aria-busy')
  await expect(rescan).toBeFocused()
  await expect(confirmClear).not.toHaveAttribute('aria-busy')
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
})

test('waits out an older cache poll and refreshes again after a mutation', async ({ page }) => {
  const body = page.locator('body')
  const requestsBefore = Number(await body.getAttribute('data-cache-stats-request-count'))
  await holdNextFixtureAction(page, 'refresh')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(body).toHaveAttribute('data-fixture-pending-action', 'refresh')

  const retention = page.getByRole('spinbutton', { name: 'Scroll cache retention (days)' })
  const apply = page.getByRole('button', { name: /Apply retention/ })
  await retention.fill('31')
  await apply.click()
  await expect(body).toHaveAttribute('data-retention-request-count', '1')
  await expect(apply).toHaveAttribute('aria-busy', 'true')

  await releaseFixtureAction(page, 'refresh')
  await expect(body).toHaveAttribute('data-cache-stats-request-count', String(requestsBefore + 2))
  await expect(apply).not.toHaveAttribute('aria-busy')
  await expect(retention).toHaveValue('31')
  await expect(apply).toHaveAttribute('aria-disabled', 'true')
})

test('reports action failures and keeps the last successful live data visible', async ({ page }) => {
  await page.goto('/?fail-retention')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')

  await page.getByRole('spinbutton', { name: 'Scroll cache retention (days)' }).fill('31')
  await page.getByRole('button', { name: 'Apply retention', exact: true }).click()
  await expect(page.getByText('Panel action failed: HTTP 503', { exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')
})

test('explains unavailable filesystem guidance and failed live-data refreshes', async ({ page }) => {
  await page.goto('/?fail-cache-stats')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  const unavailableStats = page.getByText('Statistics unavailable: HTTP 503', { exact: true })
  await expect(unavailableStats).toHaveAttribute('role', 'status')

  // A roled live region must not also carry aria-live, which double announces on some screen
  // readers. Both roles that imply a live region are covered, the panel's own and the library's
  // alike, and the attribute selector pins the literal pairing the rule is about.
  const roledRegions = page.locator('[role="status"], [role="alert"]')
  const roledRegionCount = await roledRegions.count()
  expect(roledRegionCount).toBeGreaterThan(0)
  for (let index = 0; index < roledRegionCount; index += 1) {
    await expect(roledRegions.nth(index)).not.toHaveAttribute('aria-live')
  }

  await page.goto('/?fail-cache-info')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByText('Filesystem-specific cache guidance is unavailable: HTTP 503.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')

  await page.goto('/?fail-cache-refresh')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')
  await page.getByRole('button', { name: /Refresh/ }).click()
  await expect(page.getByText('Cache statistics refresh failed: HTTP 503.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')
})

test('supports keyboard operation and visible focus in every explicit theme', async ({ page }) => {
  const root = page.locator('[data-snui-root]')
  const auto = page.getByRole('radio', { name: 'Auto' })
  const system = page.getByRole('radio', { name: 'System' })
  const light = page.getByRole('radio', { name: 'Light' })
  const dark = page.getByRole('radio', { name: 'Dark' })
  const night = page.getByRole('radio', { name: 'Night' })

  // Since signalk-nearlcrews-ui 0.5.0, a fresh profile resolves to Auto (no explicit theme
  // attribute), and the radio group's roving tabindex follows the checked option, so Tab lands on
  // Auto. Arrow keys move the selection through System and the explicit themes.
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('Tab')
  await expect(auto).toBeFocused()
  await expect(root).not.toHaveAttribute('data-snui-theme')
  await expectVisibleFocusRing(auto)
  await page.keyboard.press('ArrowRight')
  await expect(system).toBeFocused()
  await expect(root).toHaveAttribute('data-snui-theme', 'system')
  await expectVisibleFocusRing(system)
  await page.keyboard.press('ArrowRight')
  await expect(light).toBeFocused()
  await expect(root).toHaveAttribute('data-snui-theme', 'light')
  await expectVisibleFocusRing(light)
  await page.keyboard.press('ArrowRight')
  await expect(dark).toBeFocused()
  await expect(root).toHaveAttribute('data-snui-theme', 'dark')
  await expectVisibleFocusRing(dark)
  await page.keyboard.press('ArrowRight')
  await expect(night).toBeFocused()
  await expect(root).toHaveAttribute('data-snui-theme', 'night')
  await expectVisibleFocusRing(night)

  const clear = page.getByRole('button', { name: 'Clear scroll cache', exact: true }).first()
  await clear.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(clear).toBeFocused()
  await expectVisibleFocusRing(clear)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Clear scroll cache?' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Clear scroll cache?' })).toHaveCount(0)
  await expect(clear).toBeFocused()
})

test('supports every theme and persists the choice', async ({ page }) => {
  // The legacy cl-theme key is no longer read: since signalk-nearlcrews-ui 0.5.0 the theme
  // resolves from the single signalk-nearlcrews-ui.theme.v1 key, and an unresolved preference
  // falls to Auto rather than Light.
  const root = page.locator('[data-snui-root]')
  await expect(root).not.toHaveAttribute('data-snui-theme')

  const themeGroup = page.getByRole('radiogroup', { name: 'Panel theme' })
  for (const [label, value] of [
    ['System', 'system'],
    ['Light', 'light'],
    ['Dark', 'dark'],
    ['Night', 'night']
  ] as const) {
    await themeGroup.getByRole('radio', { name: label }).click()
    await expect(root).toHaveAttribute('data-snui-theme', value)
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), themeStorageKey))
      .toBe(value)
  }
  await themeGroup.getByRole('radio', { name: 'Auto' }).click()
  await expect(root).not.toHaveAttribute('data-snui-theme')
})

test('keeps its theme when another panel version writes an unrecognized shared value', async ({ page }) => {
  // Signal K Admin can load panels built against different versions of the library, and they all
  // share one theme key. A value this version does not recognize is ignored, so the panel does not
  // fight the theme another panel just wrote. Only a genuine clear returns it to Auto.
  const root = page.locator('[data-snui-root]')
  await page.getByRole('radiogroup', { name: 'Panel theme' }).getByRole('radio', { name: 'Night' }).click()
  await expect(root).toHaveAttribute('data-snui-theme', 'night')

  await writeSharedThemeFromAnotherDocument(page, 'midnight-red')
  await expect(root).toHaveAttribute('data-snui-theme', 'night')

  await writeSharedThemeFromAnotherDocument(page, 'light')
  await expect(root).toHaveAttribute('data-snui-theme', 'light')

  await writeSharedThemeFromAnotherDocument(page, null)
  await expect(root).not.toHaveAttribute('data-snui-theme')
})

test('has no Axe findings or page overflow at 320 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.getByRole('group', { name: 'Used' }).waitFor()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('responds to a 320-pixel embedded panel inside a wide host', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('main').evaluate((element) => {
    element.style.width = '320px'
  })

  const root = page.locator('[data-snui-root]')
  await expect(root).toHaveCSS('width', '320px')
  const overflow = await root.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  expect(page.viewportSize()).toMatchObject({ width: 1280 })
})

/** Everything a finger or cursor can activate. */
const INTERACTIVE_SELECTOR = [
  'button',
  '[role="button"]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'a[href]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="switch"]',
  'summary',
  '[tabindex="0"]'
].join(', ')

/**
 * Every control has to be big enough to hit and actually on top at the point you would hit it.
 * Measuring size alone is unsound in both directions. A control nested inside its own label is
 * activated by the whole label, so measuring the control under-reports the target and can raise a
 * false alarm: the geocoding checkbox input is 20 pixels inside a label the library sizes to the
 * floor. Measuring without scrolling can also report a control that is present but covered by the
 * docked action bar at that scroll position, which is inherent to a viewport-bottom bar rather than
 * a defect. So each control is scrolled to the viewport centre first, the way a user's own scrolling
 * would put it, then both halves are asserted.
 */
test('every interactive control meets its pointer target floor and is reachable', async ({ page }) => {
  await page.getByRole('button', { name: 'Advanced', exact: true }).click()
  await page.getByRole('button', { name: 'Clear scroll cache', exact: true }).first().click()
  await page.getByRole('region', { name: 'Clear scroll cache?' }).waitFor()

  const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)
  const floor = coarse ? 44 : 40

  const controls = await page.evaluate(async (selector) => {
    const settle = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
    }
    const targetOf = (element: Element): Element => element.closest('label') ?? element
    const describe = (element: Element): string => {
      const aria = element.getAttribute('aria-label')
      const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
      const kind = `${element.tagName.toLowerCase()}${element.getAttribute('type') === null ? '' : `[${element.getAttribute('type')}]`}`
      return `${kind} ${aria !== null && aria !== '' ? aria : text}`.trim()
    }

    // Drop focus first. A viewport-bottom action bar deliberately keeps the focused control clear of
    // itself, so with the inline confirmation focused near the page bottom the bar scrolls back
    // against any attempt to move far away from it, and a control at the other end of the document
    // never reaches the viewport. That clearance is the feature working; it just has nothing to do
    // with target geometry, so the sweep measures with nothing focused.
    ;(document.activeElement as HTMLElement | null)?.blur()
    await settle()

    // Scroll by explicit window position rather than scrollIntoView. WebKit honours the latter only
    // partially here, leaving a control hundreds of pixels above the viewport, which would report as
    // unreachable and look exactly like a real defect.
    const centre = async (element: Element): Promise<void> => {
      const rect = element.getBoundingClientRect()
      const wanted = rect.top + window.scrollY + rect.height / 2 - window.innerHeight / 2
      window.scrollTo(0, Math.max(0, wanted))
      await settle()
    }

    const measured: Array<{
      name: string, height: number, width: number, reachable: boolean, onScreen: boolean
    }> = []
    for (const element of [...document.querySelectorAll(selector)]) {
      await centre(element)
      const target = targetOf(element)
      const box = target.getBoundingClientRect()
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      const topmost = document.elementFromPoint(x, y)
      measured.push({
        name: describe(element),
        height: box.height,
        width: box.width,
        onScreen: x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight,
        reachable: topmost !== null &&
          (topmost === element || element.contains(topmost) || target.contains(topmost))
      })
    }
    return measured
  }, INTERACTIVE_SELECTOR)

  // Guard the probe itself: a selector that silently matched nothing would pass every assertion.
  expect(controls.length, 'the panel should expose its full control set').toBeGreaterThanOrEqual(20)

  const undersized = controls
    .filter((control) => control.height + 0.05 < floor || control.width + 0.05 < floor)
    .map((control) => `${control.name}: ${Math.round(control.height)}x${Math.round(control.width)}`)
  expect(undersized, `controls below the ${floor} pixel floor`).toEqual([])

  // A control that cannot be brought on screen would make the reachability result meaningless, so it
  // is reported as its own failure rather than being folded in as a coverage problem.
  const offScreen = controls.filter((control) => !control.onScreen).map((control) => control.name)
  expect(offScreen, 'controls that could not be scrolled into view').toEqual([])

  const unreachable = controls.filter((control) => !control.reachable).map((control) => control.name)
  expect(unreachable, 'controls covered by something else at their own centre').toEqual([])
})

test('shows a compatibility message when native CSS scope is unavailable', async ({ page }) => {
  await page.goto('/?unsupported-css-scope')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.locator('[data-browser-compatibility-message]')).toContainText('Browser update required')
  await expect(page.locator('[data-snui-root]')).toHaveCount(0)
})
