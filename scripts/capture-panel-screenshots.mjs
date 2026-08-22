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

let browser
try {
  browser = await chromium.launch()
  const page = await browser.newPage({
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'America/Detroit',
    viewport: { width: 1280, height: 800 }
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
    await page.screenshot({ animations: 'disabled', path })
  }
} finally {
  await browser?.close()
  await server.close()
}
