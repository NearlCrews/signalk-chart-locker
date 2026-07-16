import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

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

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByRole('heading', { name: 'Plugin status' })).toBeVisible()
  await expect(page.getByText('700.0 MiB')).toBeVisible()
})

test('loads the production remote and completes save and discard flows', async ({ page }) => {
  const root = page.locator('[data-snui-root]')
  await expect(root).toHaveAttribute('data-snui-version', '0.2.0')
  await expect(page.locator('style[data-snui-styles="0.2.0"]')).toHaveCount(1)
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
  await saveButton.click()

  await expect(page.locator('body')).toHaveAttribute('data-save-count', '1')
  await expect(page.locator('body')).toHaveAttribute('data-saved-configuration', /charts\/new/)
  const actionStatus = page.locator('[data-panel-action-bar] [tabindex="-1"]')
  await expect(actionStatus).toBeFocused()
  await expect(actionStatus).toContainText('Saved')
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

  const advanced = page.locator('details').filter({ has: page.getByText('Advanced', { exact: true }) })
  const imageTag = page.getByRole('textbox', { name: 'Tile cache container image tag' })
  await expect(advanced).toHaveAttribute('open', '')
  await expect(page.getByText('The container image tag is not a valid OCI tag.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect(imageTag).toHaveAttribute('aria-invalid', 'true')

  await imageTag.fill('test-build')
  await expect(imageTag).not.toHaveAttribute('aria-invalid')
  await expect(imageTag).toBeFocused()
  await expect(advanced).toHaveAttribute('open', '')
})

test('saves the optional place-name lookup preference', async ({ page }) => {
  const advanced = page.locator('details').filter({ has: page.getByText('Advanced', { exact: true }) })
  await advanced.getByText('Advanced', { exact: true }).click()

  const geocoding = page.getByRole('checkbox', { name: 'Enable place-name lookup' })
  await expect(geocoding).toBeChecked()
  await geocoding.uncheck()
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.locator('body')).toHaveAttribute('data-saved-configuration', /"geocodingEnabled":false/)
})

test('uses an inline confirmation for destructive cache clearing', async ({ page }) => {
  const clearButton = page.getByRole('button', { name: 'Clear scroll cache', exact: true }).first()
  await clearButton.click()
  await expect(page.getByRole('heading', { name: 'Clear scroll cache?' })).toBeVisible()

  const cancelButton = page.getByRole('button', { name: 'Cancel' })
  await expect(cancelButton).toBeFocused()
  await cancelButton.click()
  await expect(clearButton).toBeFocused()
  await expect(page.locator('body')).not.toHaveAttribute('data-clear-request-count')

  await clearButton.click()
  await page.keyboard.press('Tab')
  const confirmButton = page.getByRole('button', { name: 'Clear scroll cache', exact: true }).last()
  await expect(confirmButton).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('body')).toHaveAttribute('data-clear-request-count', '1')
  await expect(page.getByRole('heading', { name: 'Clear scroll cache?' })).toHaveCount(0)
  await expect(clearButton).toBeFocused()
})

test('runs cache and chart actions with stable focus, loading state, and repeat suppression', async ({ page }) => {
  await page.goto('/?hold-actions')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByText('700.0 MiB')).toBeVisible()

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
  const confirmation = page.getByRole('heading', { name: 'Clear scroll cache?' }).locator('..')
  const confirmClear = confirmation.getByRole('button', { name: /Clear scroll cache/ })
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused()

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
  await page.getByRole('button', { name: 'Cancel' }).click()
})

test('reports action failures and keeps the last successful live data visible', async ({ page }) => {
  await page.goto('/?fail-retention')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByText('700.0 MiB')).toBeVisible()

  await page.getByRole('spinbutton', { name: 'Scroll cache retention (days)' }).fill('31')
  await page.getByRole('button', { name: 'Apply retention', exact: true }).click()
  await expect(page.getByText('Panel action failed: HTTP 503', { exact: true })).toBeVisible()
  await expect(page.getByText('700.0 MiB')).toBeVisible()
})

test('explains unavailable filesystem guidance and failed live-data refreshes', async ({ page }) => {
  await page.goto('/?fail-cache-stats')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  const unavailableStats = page.getByText('Statistics unavailable: HTTP 503', { exact: true })
  await expect(unavailableStats).toHaveAttribute('role', 'status')
  await expect(unavailableStats).toHaveAttribute('aria-live', 'polite')

  await page.goto('/?fail-cache-info')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByText('Filesystem-specific cache guidance is unavailable: HTTP 503.')).toBeVisible()
  await expect(page.getByText('700.0 MiB')).toBeVisible()

  await page.goto('/?fail-cache-refresh')
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  await expect(page.getByText('700.0 MiB')).toBeVisible()
  await page.getByRole('button', { name: /Refresh/ }).click()
  await expect(page.getByText('Cache statistics refresh failed: HTTP 503.')).toBeVisible()
  await expect(page.getByText('700.0 MiB')).toBeVisible()
})

test('supports keyboard operation and visible focus in every explicit theme', async ({ page }) => {
  const root = page.locator('[data-snui-root]')
  const auto = page.getByRole('radio', { name: 'Auto' })
  const light = page.getByRole('radio', { name: 'Light' })
  const dark = page.getByRole('radio', { name: 'Dark' })
  const night = page.getByRole('radio', { name: 'Night' })

  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('Tab')
  await expect(auto).toBeFocused()
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

test('migrates the legacy preference and supports every theme', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.removeItem('signalk-nearlcrews-ui.theme.v1')
    localStorage.setItem('cl-theme', 'night')
  })
  await page.reload()
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true')
  const root = page.locator('[data-snui-root]')
  await expect(root).toHaveAttribute('data-snui-theme', 'night')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('signalk-nearlcrews-ui.theme.v1')))
    .toBe('night')

  const themeGroup = page.getByRole('radiogroup', { name: 'Panel theme' })
  for (const [label, value] of [
    ['Light', 'light'],
    ['Dark', 'dark'],
    ['Night', 'night']
  ] as const) {
    await themeGroup.getByRole('radio', { name: label }).click()
    await expect(root).toHaveAttribute('data-snui-theme', value)
  }
  await themeGroup.getByRole('radio', { name: 'Auto' }).click()
  await expect(root).not.toHaveAttribute('data-snui-theme')
})

test('has no Axe findings or page overflow at 320 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.getByText('700.0 MiB').waitFor()

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
