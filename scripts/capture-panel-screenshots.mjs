import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: resolve('fixtures/browser/vite.config.ts'),
  logLevel: 'warn'
})
await server.listen()

let browser
try {
  browser = await chromium.launch()
  const page = await browser.newPage({
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'America/Detroit',
    viewport: { width: 1212, height: 1908 }
  })
  await page.goto('http://127.0.0.1:4175/?screenshots')
  await page.locator('body[data-fixture-ready="true"]').waitFor()
  await page.getByText('700.0 MiB').waitFor()
  await page.getByText('2 valid charts, 0 invalid.', { exact: false }).waitFor()

  const panel = page.locator('[data-snui-root]')
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
    await panel.screenshot({ animations: 'disabled', path })
  }
} finally {
  await browser?.close()
  await server.close()
}
