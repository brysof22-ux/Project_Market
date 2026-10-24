import { test, expect } from '@playwright/test'
import { createWorker, type Env, type Fetcher } from '../../worker/api/src'

const env: Env = {
  SUPABASE_URL: 'https://private-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_PRIVATE_KEY_SENTINEL',
  ALLOWED_ORIGIN: 'https://project-market.pages.dev', MEDIA: {},
}
const jwt = 'PRIVATE.JWT.SENTINEL'
const secret = 'PRIVATE_EXCEPTION_MESSAGE_AND_STACK'
const user = { id: '10000000-0000-0000-0000-000000000001', email: 'private@example.test', password: 'PRIVATE_PASSWORD' }
const originalLog = console.log
const originalError = console.error
const originalTimeout = AbortSignal.timeout
let calls: unknown[][]

test.beforeEach(() => {
  calls = []
  console.log = (...args: unknown[]) => { calls.push(args) }
  console.error = (...args: unknown[]) => { calls.push(args) }
})
test.afterEach(() => {
  console.log = originalLog
  console.error = originalError
  AbortSignal.timeout = originalTimeout
})

function request(authorization: string | null = `Bearer ${jwt}`) {
  return new Request('https://api.test/api/me?private_query=PRIVATE_QUERY', {
    headers: authorization ? { Authorization: authorization } : {},
  })
}

function diagnostics() {
  for (const args of calls) {
    expect(args).toHaveLength(1)
    expect(typeof args[0]).toBe('string')
  }
  const serialized = JSON.stringify(calls)
  for (const value of [jwt, env.SUPABASE_PUBLISHABLE_KEY, env.SUPABASE_URL,
    ...Object.values(user), secret, 'PRIVATE_QUERY', 'PRIVATE_HEADER', 'PRIVATE_CUSTOM_NAME',
    'Authorization', 'apikey', 'Bearer', 'stack', 'message']) {
    expect(serialized).not.toContain(value)
  }
  return calls.map(([entry]) => {
    const log = JSON.parse(entry as string)
    expect(Object.keys(log).sort()).toEqual([
      'event', 'phase', 'duration_ms', 'upstream_status', 'exception_type', 'timeout',
    ].sort())
    expect(log.event).toBe('auth_diagnostic')
    expect(['auth_fetch', 'auth_body']).toContain(log.phase)
    expect(Number.isInteger(log.duration_ms)).toBe(true)
    expect(log.duration_ms).toBeGreaterThanOrEqual(0)
    expect(typeof log.timeout).toBe('boolean')
    return log
  })
}

for (const status of [400, 401, 403, 429, 500, 503]) {
  test(`diagnóstico HTTP ${status} sin encabezados ni cuerpo sensible`, async () => {
    let upstreamCalls = 0
    const upstream: Fetcher = async () => {
      upstreamCalls++
      return Response.json({ ...user, message: secret }, {
        status, headers: { 'x-sb-error-code': 'PRIVATE_HEADER' },
      })
    }
    const response = await createWorker(upstream).fetch(request(), env)
    expect(response.status).toBe([400, 401, 403].includes(status) ? 401 : 503)
    expect(upstreamCalls).toBe(1)
    expect(diagnostics()).toEqual([{
      event: 'auth_diagnostic', phase: 'auth_fetch', duration_ms: expect.any(Number),
      upstream_status: status, exception_type: null, timeout: false,
    }])
  })
}

for (const [index, [cause, normalized, timeout]] of ([
  [new TypeError(secret), 'TypeError', false],
  [new DOMException(secret, 'TimeoutError'), 'TimeoutError', true],
  [new DOMException(secret, 'AbortError'), 'AbortError', false],
  [Object.assign(new Error(secret), { name: 'PRIVATE_CUSTOM_NAME', stack: secret }), 'UnknownError', false],
  [{ name: 'PRIVATE_CUSTOM_NAME', message: secret, user }, 'UnknownError', false],
  [secret, 'UnknownError', false],
  [null, 'UnknownError', false],
] as const).entries()) {
  test(`excepción normalizada ${normalized}, timeout=${timeout}, caso ${index}`, async () => {
    const response = await createWorker(async () => { throw cause }).fetch(request(), env)
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('AUTH_UNAVAILABLE')
    expect(diagnostics()).toEqual([{
      event: 'auth_diagnostic', phase: 'auth_fetch', duration_ms: expect.any(Number),
      upstream_status: null, exception_type: normalized, timeout,
    }])
  })
}

test('timeout propio se identifica aunque fetch lance TypeError', async () => {
  const controller = new AbortController()
  controller.abort(new DOMException(secret, 'TimeoutError'))
  AbortSignal.timeout = (milliseconds) => {
    expect(milliseconds).toBe(10_000)
    return controller.signal
  }
  const response = await createWorker(async () => { throw new TypeError(secret) }).fetch(request(), env)
  expect(response.status).toBe(503)
  expect(diagnostics()[0]).toMatchObject({ exception_type: 'TypeError', timeout: true })
})

test('éxito: fases fetch/body sin datos de usuario y respuesta pública intacta', async () => {
  const profile = { id: user.id, display_name: 'PRIVATE_DISPLAY_NAME', role: 'cashier', active: true }
  const upstream: Fetcher = async (input) => String(input).endsWith('/auth/v1/user')
    ? Response.json(user) : Response.json([profile])
  const response = await createWorker(upstream).fetch(request(), env)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(profile)
  expect(JSON.stringify(calls)).not.toContain(profile.display_name)
  const logs = diagnostics()
  expect(logs.map((log) => log.phase)).toEqual(['auth_fetch', 'auth_body'])
  for (const log of logs) expect(log).toMatchObject({ upstream_status: 200, exception_type: null, timeout: false })
})

for (const timeout of [false, true]) {
  test(`fallo de lectura del cuerpo conserva 502, timeout=${timeout}`, async () => {
    const upstream: Fetcher = async () => {
      const response = new Response('PRIVATE_BODY')
      response.json = async () => {
        throw timeout ? new DOMException(secret, 'TimeoutError') : new SyntaxError(secret)
      }
      return response
    }
    const response = await createWorker(upstream).fetch(request(), env)
    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe('INVALID_UPSTREAM_RESPONSE')
    expect(JSON.stringify(calls)).not.toContain('PRIVATE_BODY')
    const logs = diagnostics()
    expect(logs).toHaveLength(2)
    expect(logs[1]).toMatchObject({ phase: 'auth_body', upstream_status: 200,
      exception_type: timeout ? 'TimeoutError' : 'SyntaxError', timeout })
  })
}

test('fallo al crear la señal conserva AUTH_UNAVAILABLE y se sanea', async () => {
  AbortSignal.timeout = () => { throw Object.assign(new Error(secret), { name: 'PRIVATE_CUSTOM_NAME' }) }
  let fetched = false
  const response = await createWorker(async () => { fetched = true; return Response.json(user) }).fetch(request(), env)
  expect(fetched).toBe(false)
  expect(response.status).toBe(503)
  expect(diagnostics()[0]).toMatchObject({ phase: 'auth_fetch', exception_type: 'UnknownError', timeout: false })
})

test('logger averiado no altera el 401 público', async () => {
  console.log = () => { throw new Error(secret) }
  const response = await createWorker(async () => new Response(null, { status: 403 })).fetch(request(), env)
  expect(response.status).toBe(401)
  expect((await response.json()).error.code).toBe('UNAUTHORIZED')
})

test('sin token, CORS rechazado o health no generan diagnósticos Auth', async () => {
  const api = createWorker(async () => { throw new Error('should not fetch') })
  expect((await api.fetch(request(null), env)).status).toBe(401)
  expect((await api.fetch(new Request('https://api.test/health'), env)).status).toBe(200)
  expect((await api.fetch(new Request(request(), { headers: { Origin: 'https://evil.test' } }), env)).status).toBe(403)
  expect(diagnostics()).toEqual([])
})
