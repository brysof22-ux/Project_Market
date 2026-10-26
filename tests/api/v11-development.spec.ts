import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { productionTargets } from '../../shared/production-config'
import { readFileSync } from 'node:fs'
import { createWorker, type Env } from '../../worker/api/src'

for (const [name, value] of Object.entries({ VITE_SUPABASE_URL: productionTargets.supabase, VITE_API_URL: productionTargets.api })) {
  test(`V1.1 no inicia desarrollo conectado a producción mediante ${name}`, () => {
    const output = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
      env: { ...process.env, VITE_SUPABASE_URL: 'https://unit.invalid', VITE_API_URL: 'https://api.invalid', [name]: value },
      encoding: 'utf8', timeout: 20_000,
    })
    expect(output.error).toBeUndefined()
    expect(output.status).not.toBe(0)
    expect(output.stderr).toContain('DEVELOPMENT_PRODUCTION_BLOCKED')
  })
}

test('dev:api usa configuración local con barrera de red y R2 sin acceso remoto', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(manifest.scripts['dev:api']).toBe('npx wrangler@4 dev --config worker/api/wrangler.local.jsonc --local')
  const config = JSON.parse(readFileSync('worker/api/wrangler.local.jsonc', 'utf8'))
  expect(config.vars.LOCAL_ONLY).toBe('true')
  expect(config.vars.SUPABASE_URL).toBe('https://local-only.invalid')
  expect(config.workers_dev).toBe(false)
  expect(config.r2_buckets).toEqual([{ binding: 'MEDIA', bucket_name: 'cai-market-media-v11-local', remote: false }])
})

const localEnv: Env = { LOCAL_ONLY: 'true', SUPABASE_URL: 'https://local-only.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_private_test_marker', ALLOWED_ORIGIN: 'http://localhost:5173', MEDIA: {} }
const request = () => new Request('http://localhost:8787/api/me', { headers: { Authorization: 'Bearer fake.payload.signature' } })

for (const target of [productionTargets.supabase, 'https://another-project.supabase.co',
  'https://localhost.evil.example', 'https://127.0.0.1.evil.example', 'http://public.invalid']) {
  test(`LOCAL_ONLY rechaza destino remoto o protocolo no permitido: ${new URL(target).hostname}`, async () => {
    let calls = 0
    const worker = createWorker(async () => { calls++; throw new Error('must_not_fetch') })
    const response = await worker.fetch(request(), { ...localEnv, SUPABASE_URL: target })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Servicio temporalmente no disponible.' } })
    expect(calls).toBe(0)
  })
}

for (const flag of ['false', '', '0']) {
  test(`LOCAL_ONLY presente inválido no permite desactivar la barrera: ${JSON.stringify(flag)}`, async () => {
    let calls = 0
    const worker = createWorker(async () => { calls++; throw new Error('must_not_fetch') })
    const response = await worker.fetch(request(), { ...localEnv, LOCAL_ONLY: flag })
    expect(response.status).toBe(503)
    expect(calls).toBe(0)
    const body = await response.text()
    for (const privateValue of [localEnv.SUPABASE_URL, localEnv.SUPABASE_PUBLISHABLE_KEY, 'fake.payload.signature', 'must_not_fetch']) expect(body).not.toContain(privateValue)
  })
}

for (const target of ['https://local-only.invalid', 'http://localhost:54321', 'http://127.0.0.1:54321', 'http://[::1]:54321', 'https://127.0.0.1:54321']) {
  test(`LOCAL_ONLY admite únicamente salida controlada: ${target}`, async () => {
    let calls = 0
    const worker = createWorker(async (input) => {
      calls++
      expect(String(input)).toBe(`${new URL(target).origin}/auth/v1/user`)
      return Response.json({ code: 'bad_jwt' }, { status: 403 })
    })
    const response = await worker.fetch(request(), { ...localEnv, SUPABASE_URL: target })
    expect(response.status).toBe(401)
    expect(calls).toBe(1)
  })
}

test('sin LOCAL_ONLY la configuración publicada conserva HTTPS obligatorio', async () => {
  let calls = 0
  const worker = createWorker(async () => { calls++; return Response.json({ code: 'bad_jwt' }, { status: 403 }) })
  const { LOCAL_ONLY: _localOnly, ...productionEnv } = localEnv
  expect((await worker.fetch(request(), { ...productionEnv, SUPABASE_URL: productionTargets.supabase })).status).toBe(401)
  expect(calls).toBe(1)
  expect((await worker.fetch(request(), { ...productionEnv, SUPABASE_URL: 'http://127.0.0.1:54321' })).status).toBe(503)
  expect(calls).toBe(1)
})
