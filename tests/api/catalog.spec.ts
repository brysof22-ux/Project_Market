import { test, expect } from '@playwright/test'
import { createWorker, type Env, type Fetcher } from '../../worker/api/src'

const env: Env = { SUPABASE_URL: 'https://unit.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', ALLOWED_ORIGIN: 'https://project-market.pages.dev', MEDIA: {} }
const profile = { id: '10000000-0000-0000-0000-000000000001', display_name: 'Empleado', role: 'admin', active: true }
function request(body: unknown, options: { token?: boolean; contentType?: string } = {}) {
  return new Request('https://api.test/api/catalog', { method: 'POST',
    headers: { ...(options.token === false ? {} : { Authorization: 'Bearer fake.payload.signature' }),
      'Content-Type': options.contentType ?? 'application/json', Origin: env.ALLOWED_ORIGIN }, body: JSON.stringify(body) })
}
test('catálogo verifica Auth/perfil antes de RPC con JWT original y esquema public', async () => {
  const calls: string[] = []
  const upstream: Fetcher = async (input, init) => {
    const url = String(input)
    calls.push(url)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake.payload.signature')
    expect(init?.redirect).toBe('manual')
    if (url.endsWith('/user')) return Response.json({ id: profile.id })
    if (url.endsWith('/cai_current_profile')) return Response.json([profile])
    expect(new Headers(init?.headers).get('Content-Profile')).toBe('public')
    expect(JSON.parse(String(init?.body))).toEqual({ p_action: 'products.list', p_data: { limit: 20 }, p_key: null })
    return Response.json({ rows: [], total: 0 })
  }
  const response = await createWorker(upstream).fetch(request({ action: 'products.list', data: { limit: 20 } }), env)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ rows: [], total: 0 })
  expect(calls).toHaveLength(3)
})
test('catálogo sin sesión o con perfil inactivo no llega a operación comercial', async () => {
  let calls = 0
  const api = createWorker(async (input) => {
    calls++
    return Response.json(String(input).endsWith('/user') ? { id: profile.id } : [])
  })
  expect((await api.fetch(request({}, { token: false }), env)).status).toBe(401)
  expect(calls).toBe(0)
  expect((await api.fetch(request({ action: 'product.save', data: {} }), env)).status).toBe(403)
  expect(calls).toBe(2)
})
test('CORS POST solo para catálogo y Content-Type permitido sin ampliar /api/me', async () => {
  const api = createWorker()
  const headers = { Origin: env.ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
  const response = await api.fetch(new Request('https://api.test/api/catalog', { method: 'OPTIONS', headers }), env)
  expect(response.status).toBe(204)
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS')
  expect((await api.fetch(new Request('https://api.test/api/me', { method: 'OPTIONS', headers }), env)).status).toBe(405)
})
for (const [body, contentType, expected] of [
  [{ action: 'execute.sql', data: {} }, 'application/json', 400],
  [{ action: 'products.list', data: [] }, 'application/json', 400],
  [{ action: 'products.list', data: {} }, 'text/plain', 415],
  [{ action: 'products.list', data: {} }, 'application/jsonp', 415],
  [{ action: 'product.save', data: { name: 'x'.repeat(33_000) } }, 'application/json', 413],
] as const) {
  test(`rechaza operación malformada ${expected}-${contentType}-${JSON.stringify(body).length}`, async () => {
    let calls = 0
    const api = createWorker(async (input) => { calls++; return Response.json(String(input).endsWith('/user') ? { id: profile.id } : [profile]) })
    expect((await api.fetch(request(body, { contentType }), env)).status).toBe(expected)
    expect(calls).toBe(2)
  })
}
