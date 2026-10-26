import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'

for (const branch of ['release/cai-market-v1', 'feature/cai-market-v1.1']) test(`la rama ${branch} no publica una Preview automática sin backend aislado`, () => {
  const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    env: { ...process.env, CF_PAGES_BRANCH: branch },
    encoding: 'utf8', timeout: 20_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('PREVIEW_BLOCKED')
})
