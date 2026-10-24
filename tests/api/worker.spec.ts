import { test, expect } from '@playwright/test'
import { createWorker, type Env, type Fetcher } from '../../worker/api/src'

const env: Env = { SUPABASE_URL: 'https://unit.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', ALLOWED_ORIGIN: 'https://project-market.pages.dev', MEDIA: Object.freeze({}) }
const token = 'fake.payload.signature'
const profile = { id: '10000000-0000-0000-0000-000000000001', display_name: 'Admin de prueba', role: 'admin', active: true }
function request(path = '/api/me', options: RequestInit = {}, authenticated = true) {
  const headers = new Headers(options.headers)
  if (authenticated) headers.set('Authorization', `Bearer ${token}`)
  return new Request(`https://api.test${path}`, { ...options, headers })
}
function fixture(options: { authStatus?: number; rpcStatus?: number; rows?: unknown; userId?: string; networkError?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const upstream: Fetcher = async (input, init = {}) => {
    calls.push({ url: String(input), init })
    if (options.networkError) throw new Error('sensitive upstream detail')
    if (String(input).endsWith('/auth/v1/user')) return Response.json({ id: options.userId ?? profile.id, email: 'private@example.test', password: 'DO_NOT_LEAK' }, { status: options.authStatus ?? 200 })
    return Response.json(options.rows ?? [profile], { status: options.rpcStatus ?? 200 })
  }
  return { api: createWorker(upstream), calls }
}

for (const header of [null, '', 'Bearer invalid', 'Basic dXNlcjpwYXNz', 'Bearer a.b.c, Bearer x.y.z']) {
  test(`sin token válido: ${header ?? 'ausente'}`, async () => {
    const { api, calls } = fixture()
    const response = await api.fetch(request('/api/me', { headers: header === null ? {} : { Authorization: header } }, false), env)
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
  })
}
for (const kind of ['invalid', 'expired']) {
  test(`Auth rechaza JWT ${kind} antes de consultar PostgreSQL`, async () => {
    const { api, calls } = fixture({ authStatus: 401 })
    // The expired fixture carries an actual past exp. Signature/expiry validation
    // is delegated to Auth and its rejection is mocked here, not reimplemented.
    const sentToken = kind === 'expired' ? `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.fake_signature` : token
    const response = await api.fetch(request('/api/me', { headers: { Authorization: `Bearer ${sentToken}` } }, false), env)
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe(`Bearer ${sentToken}`)
  })
}

for (const status of [400, 401, 403]) {
  test(`Auth HTTP ${status} bad_jwt devuelve 401, nunca AUTH_UNAVAILABLE`, async () => {
    let calls = 0
    const upstream: Fetcher = async () => {
      calls++
      return Response.json({ code: 'bad_jwt', message: 'DO_NOT_LEAK' }, {
        status, headers: { 'x-sb-error-code': 'bad_jwt' },
      })
    }
    const response = await createWorker(upstream).fetch(request('/api/me', {
      headers: { Authorization: 'Bearer aaa.bbb.ccc' },
    }, false), env)
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('UNAUTHORIZED')
    expect(calls).toBe(1)
  })
}

for (const status of [404, 422, 429, 500, 502, 503, 504]) {
  test(`Auth HTTP inesperado ${status} actualmente produce AUTH_UNAVAILABLE`, async () => {
    const { api, calls } = fixture({ authStatus: status })
    const response = await api.fetch(request(), env)
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('AUTH_UNAVAILABLE')
    expect(calls).toHaveLength(1)
  })
}

for (const cause of [
  new TypeError('sensitive network detail'),
  new DOMException('sensitive timeout detail', 'TimeoutError'),
  new DOMException('sensitive abort detail', 'AbortError'),
  new Error("The 'cache' field on 'RequestInitializerDict' is not implemented."),
]) {
  test(`excepción ${cause.name}: saneada pero indistinguible para el cliente`, async () => {
    let calls = 0
    const upstream: Fetcher = async () => { calls++; throw cause }
    const response = await createWorker(upstream).fetch(request(), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: {
      code: 'AUTH_UNAVAILABLE', message: 'No se pudo verificar la sesión.',
    } })
    expect(calls).toBe(1)
  })
}
for (const rows of [[], [{ ...profile, active: false }]]) {
  test(`perfil ${rows.length ? 'inactivo' : 'ausente'} devuelve 403`, async () => {
    const { api } = fixture({ rows })
    expect((await api.fetch(request(), env)).status).toBe(403)
  })
}
test('administrador activo: validación remota, mismo JWT y respuesta limitada sin aceptar actor', async () => {
  const { api, calls } = fixture({ rows: [{ ...profile, email: 'private@example.test', secret: 'DO_NOT_LEAK' }] })
  const response = await api.fetch(request('/api/me?user_id=OTHER&p_actor=OTHER', { headers: { Origin: env.ALLOWED_ORIGIN } }), env)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(profile)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(calls.map((call) => call.url)).toEqual([`${env.SUPABASE_URL}/auth/v1/user`, `${env.SUPABASE_URL}/rest/v1/rpc/cai_current_profile`])
  for (const call of calls) {
    expect(new Headers(call.init.headers).get('Authorization')).toBe(`Bearer ${token}`)
    expect(new Headers(call.init.headers).get('apikey')).toBe(env.SUPABASE_PUBLISHABLE_KEY)
    expect(call.init.redirect).toBe('manual')
  }
  expect(calls[0].init.cache).toBeUndefined()
  expect(calls[1].init.cache).toBe('no-store')
  expect(calls[1].init.body).toBe('{}')
  expect(new Headers(calls[1].init.headers).get('Content-Profile')).toBe('public')
})
test('un perfil de otro usuario no se devuelve', async () => {
  const { api } = fixture({ userId: 'other-user' })
  const response = await api.fetch(request(), env)
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain(profile.id)
})
test('CORS permite exclusivamente el origen configurado y sus preflight', async () => {
  const { api, calls } = fixture()
  const response = await api.fetch(request('/api/me', { method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } }, false), env)
  expect(response.status).toBe(204)
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN)
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS')
  expect(calls).toHaveLength(0)
  expect((await api.fetch(request('/api/me', { headers: { Origin: env.ALLOWED_ORIGIN } }, false), env)).headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN)
})
for (const origin of ['https://evil.test', 'https://project-market.pages.dev.evil.test', 'null', '']) {
  test(`CORS rechaza origen ${origin || 'vacío'}`, async () => {
    const { api, calls } = fixture()
    const response = await api.fetch(request('/api/me', { headers: { Origin: origin } }), env)
    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(calls).toHaveLength(0)
  })
}
test('métodos, rutas y headers de preflight no permitidos', async () => {
  const { api } = fixture()
  const post = await api.fetch(request('/api/me', { method: 'POST' }), env)
  expect(post.status).toBe(405)
  expect(post.headers.get('Allow')).toBe('GET, OPTIONS')
  expect((await api.fetch(request('/unknown'), env)).status).toBe(404)
  const preflight = await api.fetch(request('/api/me', { method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-user-id' } }), env)
  expect(preflight.status).toBe(403)
})
test('health no consulta servicios ni revela configuración', async () => {
  const { api, calls } = fixture()
  const response = await api.fetch(request('/health', {}, false), env)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok' })
  expect(calls).toHaveLength(0)
})
for (const options of [{ authStatus: 500 }, { rpcStatus: 403 }, { rpcStatus: 404 }, { rpcStatus: 500 }, { networkError: true }]) {
  test(`error de servicio se sanea ${JSON.stringify(options)}`, async () => {
    const { api } = fixture(options)
    const response = await api.fetch(request(), env)
    expect(response.status).toBe(503)
    const body = await response.text()
    for (const sensitive of ['DO_NOT_LEAK', 'private@example.test', token, env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, 'sensitive upstream', 'stack']) expect(body).not.toContain(sensitive)
  })
}
test('configuración incompleta no revela secretos', async () => {
  const { api, calls } = fixture()
  const response = await api.fetch(request(), { ...env, SUPABASE_PUBLISHABLE_KEY: '' })
  expect(response.status).toBe(503)
  expect(calls).toHaveLength(0)
})

for (const stage of ['auth', 'rpc']) {
  test(`redirección ${stage} se rechaza sin reenviar credenciales`, async () => {
    let calls = 0
    const api = createWorker(async (_input, init) => {
      calls++
      expect(init?.redirect).toBe('manual')
      if (stage === 'auth' || calls === 2) return new Response(null, {
        status: 302, headers: { Location: 'https://evil.test/DO_NOT_LEAK' },
      })
      return Response.json({ id: profile.id })
    })
    const response = await api.fetch(request(), env)
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe(stage === 'auth' ? 'AUTH_UNAVAILABLE' : 'PROFILE_UNAVAILABLE')
    expect(calls).toBe(stage === 'auth' ? 1 : 2)
  })
}
