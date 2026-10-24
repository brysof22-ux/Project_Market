import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'

test('la rama release no publica una Preview automática sin backend aislado', () => {
  const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    env: { ...process.env, CF_PAGES_BRANCH: 'release/cai-market-v1' },
    encoding: 'utf8', timeout: 20_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('PREVIEW_BLOCKED')
})
