import { defineConfig } from '@playwright/test'

// Web-standard Request/Response tests in Node. No live endpoints or browser.
export default defineConfig({
  testDir: './tests/api', workers: 1, fullyParallel: false, maxFailures: 1,
  reporter: 'list', outputDir: 'test-results/api',
})
