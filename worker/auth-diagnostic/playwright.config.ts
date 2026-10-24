import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', workers: 1, fullyParallel: false,
  reporter: 'list', outputDir: '../../test-results/auth-diagnostic',
})
