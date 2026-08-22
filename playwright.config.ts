import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  // Above Playwright's 30 second default because this spec sits close to it on reference hardware:
  // eight tests have measured over 18 seconds, the slowest at 30.6, so the default fails them on
  // timing rather than on behaviour. The two tests that need more than this say so individually.
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4178',
    locale: 'en-US',
    timezoneId: 'America/Detroit',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'vite --config fixtures/browser/vite.config.mts',
    url: 'http://127.0.0.1:4178',
    // Never adopt a server this run did not start. Reuse treats anything answering on the URL as
    // this fixture, so a neighbouring repository's panel served on the same port reads as a healthy
    // start and the whole suite then asserts against the wrong application. With reuse off and
    // strictPort set in the fixture config, a port already held fails here instead.
    reuseExistingServer: false,
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
