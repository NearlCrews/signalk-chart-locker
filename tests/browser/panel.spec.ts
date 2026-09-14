import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { PACKAGE_VERSION, THEME_STORAGE_KEY } from 'signalk-nearlcrews-ui'

// The version the bundle must stamp and the shared theme key both come from the installed package's
// public entry, which this CommonJS suite can load directly since the package added a `default`
// export condition. The panel build already proved, through the package's own consumer check, that
// the installed version is the exact one package.json pins, so the suite asserts against the value
// the bundle was built from rather than re-reading either manifest.
const snuiVersion = PACKAGE_VERSION
const themeStorageKey = THEME_STORAGE_KEY

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
  // The slider and the exact-value box are one control: both read the committed cap, and the unit
  // addon describes both, so the value is read with what it measures.
  const capSlider = page.getByRole('slider', { name: 'Cache size cap' })
  const capExact = page.getByRole('spinbutton', { name: 'Cache size cap exact value' })
  await expect(capSlider).toHaveValue('8')
  await expect(capExact).toHaveValue('8')
  await expect(capSlider).toHaveAccessibleDescription(/GiB/)
  await expect(capExact).toHaveAccessibleDescription(/GiB/)

  const chartsPath = page.getByRole('textbox', { name: 'PMTiles charts directory' })
  const saveButton = page.getByRole('button', { name: 'Save', exact: true })
  const discardButton = page.getByRole('button', { name: 'Discard', exact: true })
  await expect(saveButton).toBeDisabled()
  await expect(discardButton).toBeDisabled()

  await chartsPath.fill('/charts/outside-config')
  await expect(chartsPath).toHaveAttribute('aria-invalid', 'true')
  const chartsPathErrorId = await chartsPath.getAttribute('aria-errormessage')
  expect(chartsPathErrorId).not.toBeNull()
  // Every field error leads with its tone word, visually hidden, so the message is read inside the
  // element the control points at rather than matched as the whole text of a node.
  const chartsPathError = page.locator(`[id="${chartsPathErrorId!}"]`)
  await expect(chartsPathError).toBeVisible()
  await expect(chartsPathError).toContainText(
    'The PMTiles charts directory must stay relative to the Signal K configuration directory.'
  )
  // A save blocked by an invalid field refuses through aria-disabled rather than the native
  // attribute, so Save keeps its place in the tab order and stays reachable beside the reason.
  await expect(saveButton).toBeDisabled()
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true')
  await expect(saveButton).not.toHaveAttribute('disabled')

  await chartsPath.fill('charts/new')
  await expect(chartsPath).not.toHaveAttribute('aria-invalid')
  // The error region stays mounted and empties rather than being removed, because a live region
  // has to exist before its text changes for the next error to be announced.
  await expect(chartsPathError).toHaveText('')
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await expect(saveButton).toBeEnabled()
  const actionStatus = page.locator('[data-panel-action-bar] [tabindex="-1"]')
  await saveButton.click()

  // Check the transient request acknowledgement before slower serialization
  // assertions so a busy cross-browser run cannot outlive its display timer.
  await expect(actionStatus).toBeFocused()
  await expect(actionStatus).toContainText('Save sent to the server')
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
  const blockedSave = page.getByRole('button', { name: 'Save', exact: true })
  await expect(blockedSave).toBeDisabled()
  await expect(blockedSave).toHaveAttribute('aria-disabled', 'true')
  await expect(blockedSave).not.toHaveAttribute('disabled')
  await expect(imageTag).toHaveAttribute('aria-invalid', 'true')

  // Advanced can be collapsed again over an invalid field, so the section header carries a marker
  // and the save bar names the field rather than pointing at highlighting nobody can see.
  await expect(page.getByText('1 problem')).toBeVisible()
  const actionBar = page.locator('[data-panel-action-bar]')
  await expect(actionBar).toContainText(
    'Fix the tile cache container image tag under Advanced before saving.'
  )
  await advanced.click()
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('1 problem')).toBeVisible()
  await advanced.click()

  await imageTag.fill('test-build')
  await expect(imageTag).not.toHaveAttribute('aria-invalid')
  await expect(imageTag).toBeFocused()
  await expect(advanced).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('1 problem')).toHaveCount(0)
})

test('announces action outcomes and ambient conditions from regions that stay mounted', async ({ page }) => {
  // Each announcer is rendered before it has anything to say, because a screen reader only observes
  // a live region that already existed when its text changed.
  const alerts = page.locator('[data-panel-announcer="assertive"].snui-visually-hidden')
  const notices = page.locator('[data-panel-announcer="polite"].snui-visually-hidden')
  await expect(alerts).toHaveAttribute('role', 'alert')
  await expect(notices.first()).toHaveAttribute('role', 'status')
  await expect(alerts).toHaveCount(1)
  await expect(alerts).toHaveText('')
  await expect(notices).toHaveCount(2)
  for (const index of [0, 1]) await expect(notices.nth(index)).toHaveText('')

  await page.getByRole('button', { name: /Refresh/ }).click()
  await expect(notices.filter({ hasText: 'Cache statistics refreshed.' })).toHaveCount(1)

  const retention = page.getByRole('spinbutton', { name: 'Scroll cache retention' })
  await retention.fill('31')
  await page.getByRole('button', { name: 'Apply retention', exact: true }).click()
  await expect(notices.filter({ hasText: 'Scroll cache retention set to 31 days.' })).toHaveCount(1)

  await page.getByRole('button', { name: /Rescan charts/ }).click()
  await expect(
    notices.filter({ hasText: 'Charts rescanned: 2 valid charts, 0 invalid.' })
  ).toHaveCount(1)
})

test('reports a failed action through the assertive announcer, not a fresh region', async ({ page }) => {
  await page.goto('/?fail-retention')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  const alert = page.locator('[data-panel-announcer="assertive"].snui-visually-hidden')
  await expect(alert).toHaveCount(1)
  await expect(alert).toHaveText('')

  await page.getByRole('spinbutton', { name: 'Scroll cache retention' }).fill('31')
  await page.getByRole('button', { name: 'Apply retention', exact: true }).click()
  await expect(alert).toHaveText('Panel action failed: HTTP 503.')
})

test('summarizes unreadable chart files in one capped warning', async ({ page }) => {
  await page.goto('/?invalid-charts')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')

  const charts = page.getByRole('region', { name: 'Charts' })
  await expect(charts.getByText('7 chart files could not be read')).toBeVisible()
  await expect(charts.getByRole('listitem')).toHaveCount(5)
  await expect(charts.getByText('2 more not listed.')).toBeVisible()
  await expect(charts.getByText('1 valid chart, 7 invalid.')).toBeVisible()

  // The warning is the panel's only nested list, so audit it where it is rendered.
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('orients the operator when the charts directory holds nothing', async ({ page }) => {
  await page.goto('/?no-charts')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')

  const charts = page.getByRole('region', { name: 'Charts' })
  await expect(charts.getByText('No charts found')).toBeVisible()
  await expect(charts.getByText('Put .pmtiles files in charts/pmtiles')).toBeVisible()
  // The empty state carries the next step itself, so there is exactly one rescan control.
  await expect(charts.getByRole('button', { name: /Rescan charts/ })).toHaveCount(1)
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

// Also given its own budget, for the same reason as the sweep below. This drives four held actions
// end to end, each one waiting on a busy state, a focus move, and a released response, and WebKit has
// measured 15 to 30 seconds. It timed out on the 30 seconds this project allowed before, then passed
// three consecutive repeats minutes later, which is the signature of a budget set too close rather
// than a defect.
test('runs cache and chart actions with stable focus, loading state, and repeat suppression', async ({ page }) => {
  test.setTimeout(120_000)

  await page.goto('/?hold-actions')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')

  const body = page.locator('body')
  const retention = page.getByRole('spinbutton', { name: 'Scroll cache retention' })
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

  const retention = page.getByRole('spinbutton', { name: 'Scroll cache retention' })
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

  await page.getByRole('spinbutton', { name: 'Scroll cache retention' }).fill('31')
  await page.getByRole('button', { name: 'Apply retention', exact: true }).click()
  await expect(page.getByText('Panel action failed: HTTP 503', { exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')
})

test('explains unavailable filesystem guidance and failed live-data refreshes', async ({ page }) => {
  await page.goto('/?fail-cache-stats')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  // The loading line and the failure share one status region, so the failure lands as an update to
  // a region that already existed rather than as a freshly inserted one.
  const unavailableStats = page.getByRole('status').filter({ hasText: 'Statistics unavailable: HTTP 503' })
  await expect(unavailableStats).toBeVisible()

  // A roled live region must not also carry aria-live, which double announces on some screen
  // readers. Both roles that imply a live region are covered, the panel's own and the library's
  // alike, and the attribute selector pins the literal pairing the rule is about.
  const roledRegions = page.locator('[role="status"], [role="alert"]')
  const roledRegionCount = await roledRegions.count()
  expect(roledRegionCount).toBeGreaterThan(0)
  for (let index = 0; index < roledRegionCount; index += 1) {
    await expect(roledRegions.nth(index)).not.toHaveAttribute('aria-live')
  }

  // The panel's announcers carry the same words as the banners, so each visible banner is located
  // inside the section it belongs to rather than by text across the whole document.
  await page.goto('/?fail-cache-info')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(
    page.getByRole('region', { name: 'Tile cache' })
      .getByText('Filesystem-specific cache guidance is unavailable: HTTP 503.')
  ).toBeVisible()
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')

  await page.goto('/?fail-cache-refresh')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')
  await page.getByRole('button', { name: /Refresh/ }).click()
  await expect(
    page.getByRole('region', { name: 'Cache operations' })
      .getByText('Cache statistics refresh failed: HTTP 503.')
  ).toBeVisible()
  await expect(page.getByRole('group', { name: 'Used' })).toContainText('700.0 MiB')
})

test('supports keyboard operation and visible focus in every explicit theme', async ({ page }) => {
  const root = page.locator('[data-snui-root]')
  const auto = page.getByRole('radio', { name: 'Match Admin' })
  const system = page.getByRole('radio', { name: 'Match device' })
  const light = page.getByRole('radio', { name: 'Light' })
  const dark = page.getByRole('radio', { name: 'Dark' })
  const night = page.getByRole('radio', { name: 'Night' })

  // Since signalk-nearlcrews-ui 0.5.0, a fresh profile resolves to the automatic choice, labelled
  // "Match Admin" (no explicit theme attribute), and the radio group's roving tabindex follows the
  // checked option, so the whole group is one tab stop and that choice holds it. Arrow keys move
  // the selection through "Match device" and the explicit themes.
  // The selector sits at the foot of the panel, so the group is reached directly rather than by
  // counting tab stops from the top of a page whose sequential focus start differs by browser.
  await expect(auto).toHaveAttribute('tabindex', '0')
  await expect(system).toHaveAttribute('tabindex', '-1')
  await auto.focus()
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
    ['Match device', 'system'],
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
  await themeGroup.getByRole('radio', { name: 'Match Admin' }).click()
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
// Heavy by design, and given its own budget for that reason. The sweep enumerates every interactive
// control and pays a scroll, a settle, and a hit test for each one, so its cost grows with the panel
// rather than staying flat. WebKit has measured 27 seconds of it on an otherwise quiet host, which
// leaves too little of even the raised project budget to absorb a loaded one.
test('every interactive control meets its pointer target floor and is reachable', async ({ page }) => {
  test.setTimeout(120_000)

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
