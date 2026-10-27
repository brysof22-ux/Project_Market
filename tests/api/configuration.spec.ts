import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

test('despliegue conserva Worker, origen y bucket existentes sin acceso R2 remoto local', () => {
  const config = JSON.parse(readFileSync('worker/api/wrangler.jsonc', 'utf8'))
  expect(config.name).toBe('cai-market-api')
  expect(config.keep_vars).toBe(true)
  expect(config.vars).toEqual({ SUPABASE_URL: 'https://sauoekefntzxhqxycdgo.supabase.co', ALLOWED_ORIGIN: 'https://project-market.pages.dev', EVOLUTION_INSTANCE:'cai-market' })
  expect(config.r2_buckets).toEqual([{ binding: 'MEDIA', bucket_name: 'cai-market-media' }])
  expect(config.triggers).toEqual({crons:['*/5 * * * *']})
  expect(config.vars.EVOLUTION_API_KEY).toBeUndefined()
  expect(config.vars.WHATSAPP_DISPATCH_SECRET).toBeUndefined()
  expect(config.vars.SUPABASE_PUBLISHABLE_KEY).toBeUndefined()
  expect(config.vars.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
})
