import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

// strictPort is off here, unlike the Playwright fixture server: capturing screenshots is a local
// authoring task that should not fail because something else already holds the fixture port. The
// browser is pointed at whatever port the server actually resolved rather than a restated literal.
const server = await createServer({
  configFile: resolve('fixtures/browser/vite.config.mts'),
  logLevel: 'warn',
  server: { strictPort: false }
})
await server.listen()
const address = server.httpServer?.address()
if (address === null || address === undefined || typeof address === 'string') {
  throw new Error('the fixture server did not report a numeric address')
}
const fixtureOrigin = `http://127.0.0.1:${address.port}`

/** The frame every App Store screenshot is captured at. */
const VIEWPORT = { width: 1280, height: 800 }

let browser
try {
  browser = await chromium.launch()
  const page = await browser.newPage({
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'America/Detroit',
    viewport: VIEWPORT
  })
  await page.goto(`${fixtureOrigin}/?screenshots`)
  await page.locator('body[data-fixture-ready="true"]').waitFor()
  await page.getByText('700.0 MiB').waitFor()
  await page.getByText('2 valid charts, 0 invalid.', { exact: false }).waitFor()

  const themeGroup = page.getByRole('radiogroup', { name: 'Panel theme' })
  for (const [theme, path] of [
    ['Light', 'assets/screenshots/config-panel.png'],
    ['Dark', 'assets/screenshots/config-panel-dark.png'],
    ['Night', 'assets/screenshots/config-panel-night.png']
  ]) {
    await themeGroup.getByRole('radio', { name: theme }).click()
    await page.waitForFunction(
      (expected) => document.querySelector('[data-snui-root]')?.getAttribute('data-snui-theme') === expected,
      theme.toLowerCase()
    )
    await page.mouse.move(0, 0)
    // The theme selector sits at the foot of the panel, so choosing a theme leaves the page scrolled
    // there and the focused radio pulls it back whenever the scroll is reset. Capturing the whole
    // page and clipping the first viewport frames the plugin status and the cache figures the App
    // Store listing is meant to show, whatever the live scroll position is.
    await page.screenshot({
      animations: 'disabled',
      fullPage: true,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
      path
    })
  }
} finally {
  await browser?.close()
  await server.close()
}
