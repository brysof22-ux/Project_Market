import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { invalidProductionSettings, productionTargets } from '../../shared/production-config'

// Fictitious value used solely to exercise the format guard, never authentication.
const env = { VITE_SUPABASE_URL: productionTargets.supabase, VITE_API_URL: productionTargets.api,
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + '0123456789abcdef'.repeat(2) }

test('producción solo admite el proyecto original y la API autorizada', () => {
  expect(invalidProductionSettings(env)).toEqual([])
  for (const url of [undefined, '', 'https://another-project.supabase.co', productionTargets.supabase + '/', productionTargets.supabase + '?token=sensitive']) {
    expect(invalidProductionSettings({ ...env, VITE_SUPABASE_URL: url })).toContain('VITE_SUPABASE_URL')
  }
  expect(invalidProductionSettings({ ...env, VITE_API_URL: 'https://api-test.example' })).toContain('VITE_API_URL')
})

test('producción rechaza claves privadas, plantillas y variables adicionales del frontend', () => {
  for (const key of [undefined, '', 'sb_secret_DO_NOT_LEAK', 'sb_publishable_YOUR_PUBLIC_KEY', 'sb_publishable_playwright_fake_key', 'sb_publishable_abc\nprivate']) {
    expect(invalidProductionSettings({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: key })).toContain('VITE_SUPABASE_PUBLISHABLE_KEY')
  }
  const invalid = invalidProductionSettings({ ...env, VITE_SERVICE_ROLE: 'PRIVATE_VALUE_MUST_NOT_APPEAR' })
  expect(invalid).toEqual(['VITE_SERVICE_ROLE'])
  expect(JSON.stringify(invalid)).not.toContain('PRIVATE_VALUE_MUST_NOT_APPEAR')
})

test('la compilación de main valida el proyecto y no omite controles para publicar', () => {
  const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    env: { ...process.env, ...env, CF_PAGES_BRANCH: 'main', VITE_SUPABASE_URL: 'https://wrong-project.supabase.co' },
    encoding: 'utf8', timeout: 20_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('PRODUCTION_CONFIGURATION: VITE_SUPABASE_URL')
  expect(result.stderr).not.toContain('PREVIEW_BLOCKED')
})
