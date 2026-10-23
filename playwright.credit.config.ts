import { defineConfig } from '@playwright/test'

// SQL tests only: no browser, no dev server, no Supabase URL and no messages.
export default defineConfig({
  testDir: './tests/credit',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  maxFailures: 1,
  timeout: 30_000,
  reporter: 'list',
  outputDir: 'test-results/credit',
})
