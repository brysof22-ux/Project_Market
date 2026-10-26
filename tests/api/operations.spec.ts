import { test, expect } from '@playwright/test'
import { createWorker, type Env, type Fetcher } from '../../worker/api/src'

// All upstream responses and credentials are fictitious. No production requests.
const env: Env = {
  SUPABASE_URL: 'https://unit.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake',
  ALLOWED_ORIGIN: 'https://project-market.pages.dev', MEDIA: {},
}
const jwt = 'fake.payload.signature'
const profile = { id: '10000000-0000-0000-0000-000000000001', display_name: 'Empleado', role: 'cashier', active: true }
const sensitive = 'PRIVATE_UPSTREAM_BODY_OR_HEADER'

function request(body: unknown, authorization: string | null = `Bearer ${jwt}`) {
  return new Request('https://api.test/api/operations', {
    method: 'POST', headers: {
      Origin: env.ALLOWED_ORIGIN, 'Content-Type': 'application/json',
      ...(authorization === null ? {} : { Authorization: authorization }),
    }, body: JSON.stringify(body),
  })
}

function fixture(final: Response = Response.json({ rows: [] }), options: { authStatus?: number; rows?: unknown } = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const upstream: Fetcher = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: profile.id }, { status: options.authStatus ?? 200 })
    if (url.endsWith('/cai_current_profile')) return Response.json(options.rows ?? [profile])
    return final
  }
  return { api: createWorker(upstream), calls }
}

for (const [action, data, key, rpc, parameters] of [
  ['bootstrap', {}, undefined, 'cai_operations', { p_action: 'bootstrap', p_data: {}, p_key: null }],
  ['sale.confirm', { lines: [], payments: [] }, 'same-idempotency-key', 'cai_operations',
    { p_action: 'sale.confirm', p_data: { lines: [], payments: [] }, p_key: 'same-idempotency-key' }],
  ['report', { from: '2026-10-19', to: '2026-10-25' }, undefined, 'cai_report',
    { p_data: { from: '2026-10-19', to: '2026-10-25' } }],
] as const) {
  test(`operación ${action}: RPC correcta, parámetros mínimos y JWT original`, async () => {
    const payload = { fixture: 'business-response' }
    const { api, calls } = fixture(Response.json(payload))
    const response = await api.fetch(request({ action, data, ...(key ? { key } : {}), p_actor: 'UNTRUSTED_ACTOR' }), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(payload)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN)
    expect(calls.map((call) => call.url)).toEqual([
      `${env.SUPABASE_URL}/auth/v1/user`, `${env.SUPABASE_URL}/rest/v1/rpc/cai_current_profile`,
      `${env.SUPABASE_URL}/rest/v1/rpc/${rpc}`,
    ])
    for (const call of calls) {
      const headers = new Headers(call.init.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${jwt}`)
      expect(headers.get('apikey')).toBe(env.SUPABASE_PUBLISHABLE_KEY)
      expect(call.init.redirect).toBe('manual')
      expect(call.init.signal).toBeInstanceOf(AbortSignal)
    }
    const business = calls[2].init
    expect(business.method).toBe('POST')
    expect(business.cache).toBe('no-store')
    expect(new Headers(business.headers).get('Content-Profile')).toBe('public')
    expect(new Headers(business.headers).get('Accept-Profile')).toBe('public')
    expect(JSON.parse(String(business.body))).toEqual(parameters)
    expect(String(business.body)).not.toContain('UNTRUSTED_ACTOR')
  })
}

for (const [name, authorization, options, status, count] of [
  ['sin JWT', null, {}, 401, 0],
  ['JWT inválido', 'Bearer invalid', {}, 401, 0],
  ['JWT rechazado por Auth', `Bearer ${jwt}`, { authStatus: 403 }, 401, 1],
  ['perfil ausente', `Bearer ${jwt}`, { rows: [] }, 403, 2],
  ['perfil inactivo', `Bearer ${jwt}`, { rows: [{ ...profile, active: false }] }, 403, 2],
] as const) {
  test(`operaciones ${name}: bloquea antes de la RPC comercial`, async () => {
    const { api, calls } = fixture(undefined, options)
    const response = await api.fetch(request({ action: 'sale.confirm', data: {}, key: 'not-executed' }, authorization), env)
    expect(response.status).toBe(status)
    expect(calls).toHaveLength(count)
    expect(calls.some((call) => call.url.endsWith('/cai_operations'))).toBe(false)
  })
}

test('operaciones: CORS permite POST y cabeceras exactas sin consultar Supabase', async () => {
  const { api, calls } = fixture()
  const response = await api.fetch(new Request('https://api.test/api/operations', {
    method: 'OPTIONS', headers: {
      Origin: env.ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,accept',
    },
  }), env)
  expect(response.status).toBe(204)
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN)
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS')
  expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Accept, Content-Type')
  expect(calls).toHaveLength(0)
  const forbidden = await api.fetch(new Request(request({ action: 'bootstrap', data: {} }), {
    headers: { Origin: `${env.ALLOWED_ORIGIN}.evil.test` },
  }), env)
  expect(forbidden.status).toBe(403)
  expect(forbidden.headers.get('Access-Control-Allow-Origin')).toBeNull()
  expect(calls).toHaveLength(0)
})

for (const action of ['bootstrap', 'report']) {
  test(`redirección RPC ${action}: no sigue Location ni expone datos sensibles`, async () => {
    const { api, calls } = fixture(new Response(sensitive, {
      status: 302, headers: { Location: `https://evil.test/${sensitive}` },
    }))
    const response = await api.fetch(request({ action, data: {} }), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'CATALOG_UNAVAILABLE', message: 'El catálogo no está disponible.' } })
    expect(calls).toHaveLength(3)
    expect(calls[2].init.redirect).toBe('manual')
    expect(calls.some((call) => call.url.includes('evil.test'))).toBe(false)
    expect(response.headers.get('Location')).toBeNull()
  })
}

for (const upstreamStatus of [401, 403, 400, 409, 500]) {
  test(`error de RPC comercial HTTP ${upstreamStatus}: estado y cuerpo saneados`, async () => {
    const { api, calls } = fixture(Response.json({ message: sensitive, details: jwt, hint: env.SUPABASE_PUBLISHABLE_KEY }, { status: upstreamStatus }))
    const response = await api.fetch(request({ action: 'sale.confirm', data: {}, key: 'same-key' }), env)
    expect(response.status).toBe(upstreamStatus === 401 || upstreamStatus === 403 ? upstreamStatus : upstreamStatus === 500 ? 503 : 422)
    expect((await response.clone().json()).error.code).toBe(
      upstreamStatus === 401 ? 'UNAUTHORIZED' : upstreamStatus === 403 ? 'FORBIDDEN' : upstreamStatus === 500 ? 'CATALOG_UNAVAILABLE' : 'INVALID_OPERATION',
    )
    if (upstreamStatus === 401) expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
    const body = await response.text()
    for (const value of [sensitive, jwt, env.SUPABASE_PUBLISHABLE_KEY]) expect(body).not.toContain(value)
    expect(calls).toHaveLength(3)
  })
}

for (const error of ['INSUFFICIENT_STOCK', 'IDEMPOTENCY_CONFLICT', 'AMOUNT_EXCEEDS_DEBT', '__proto__', sensitive]) {
  test(`error comercial ${error}: solo se conserva el código permitido`, async () => {
    const { api } = fixture(Response.json({ message: error, details: sensitive }, { status: 400 }))
    const response = await api.fetch(request({ action: 'sale.confirm', data: {}, key: 'same-key' }), env)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: {
      code: ['__proto__', sensitive].includes(error) ? 'INVALID_OPERATION' : error,
      message: 'No se guardó la operación. Revisa los datos y actualiza la vista.',
    } })
  })
}
