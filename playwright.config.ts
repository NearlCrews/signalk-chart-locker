import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4175',
    locale: 'en-US',
    timezoneId: 'America/Detroit',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'vite --config fixtures/browser/vite.config.mts',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // Every project runs the whole spec. The target-size test reads the pointer media query and
    // asserts the floor that applies, 44 pixels on this coarse project and 40 on the desktop three,
    // so no project needs to skip it.
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } }
  ]
})
