import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The bundled UI package version, asserted against the served root so a dependency bump that does
// not reach the bundle fails here instead of shipping a stale runtime. Read from the file because
// the package's exports map does not expose its package.json for import.
const snuiPackage: unknown = JSON.parse(
  readFileSync(resolve('node_modules/signalk-nearlcrews-ui/package.json'), 'utf8')
)
if (typeof snuiPackage !== 'object' || snuiPackage === null ||
    !('version' in snuiPackage) || typeof snuiPackage.version !== 'string') {
  throw new Error('signalk-nearlcrews-ui package.json carries no version string')
}
const snuiVersion = snuiPackage.version
if (snuiVersion !== '0.8.0') {
  throw new Error(`expected signalk-nearlcrews-ui 0.8.0, found ${snuiVersion}`)
}

// The theme storage key, read from the package source because the exports map exposes only the ESM
// root, which the CommonJS-transformed spec cannot require. Keeps the persistence assertion on the
// library's published key rather than a restated literal.
function readThemeStorageKey (): string {
  const key = /THEME_STORAGE_KEY = "([^"]+)"/.exec(
    readFileSync(resolve('node_modules/signalk-nearlcrews-ui/dist/theme/contract.js'), 'utf8')
  )?.[1]
  if (key === undefined) throw new Error('THEME_STORAGE_KEY not found in the signalk-nearlcrews-ui theme contract')
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

test('saves the optional place-name lookup preference', async ({ page }) => {
  const advanced = page.getByRole('button', { name: 'Advanced', exact: true })
  await advanced.click()
  await expect(advanced).toHaveAttribute('aria-expanded', 'true')

  const geocoding = page.getByRole('checkbox', { name: 'Enable place-name lookup' })
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

test('provides coarse-pointer controls with 44-pixel targets @coarse', async ({ page }) => {
  for (const control of [
    page.getByRole('radio', { name: 'Auto' }),
    page.getByRole('button', { name: 'Clear scroll cache', exact: true }).first(),
    page.getByRole('button', { name: 'Save', exact: true })
  ]) {
    const box = await control.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }
})

test('shows a compatibility message when native CSS scope is unavailable', async ({ page }) => {
  await page.goto('/?unsupported-css-scope')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.locator('[data-browser-compatibility-message]')).toContainText('Browser update required')
  await expect(page.locator('[data-snui-root]')).toHaveCount(0)
})
