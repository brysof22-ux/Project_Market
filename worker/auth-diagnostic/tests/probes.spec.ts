import { test, expect } from '@playwright/test'
import { createDiagnosticWorker, type DiagnosticEnv } from '../src'

const env: DiagnosticEnv = {
  DIAGNOSTIC_ACCESS_KEY: 'LOCAL_TEST_ONLY_OPERATOR_KEY_123456789',
  SUPABASE_URL: 'https://privateproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_PRIVATE_SENTINEL',
}
const originalLog = console.log
let logs: unknown[][]
test.beforeEach(() => { logs = []; console.log = (...args: unknown[]) => { logs.push(args) } })
test.afterEach(() => { console.log = originalLog })
function request(probe: string, init: RequestInit = {}) {
  return new Request(`http://localhost/probe/${probe}`, {
    method: 'POST', ...init,
    headers: { 'X-Diagnostic-Key': env.DIAGNOSTIC_ACCESS_KEY!, Authorization: 'REAL.JWT.MUST_NOT_FORWARD', ...init.headers },
  })
}
function safeLogs() {
  const serialized = JSON.stringify(logs)
  for (const sensitive of [...Object.values(env), 'REAL.JWT.MUST_NOT_FORWARD', 'aaa.bbb.ccc',
    'PRIVATE_BODY', 'PRIVATE_MESSAGE', 'PRIVATE_EXCEPTION_NAME', 'PRIVATE_HEADER', 'https://', 'stack']) {
    expect(serialized).not.toContain(sensitive)
  }
  for (const [entry, ...extra] of logs) {
    expect(extra).toEqual([])
    expect(Object.keys(JSON.parse(entry as string)).sort()).toEqual([
      'event', 'probe', 'phase', 'duration_ms', 'upstream_status', 'exception_type', 'timeout',
    ].sort())
  }
}

for (const probe of ['baseline', 'headers-object', 'headers-instance', 'timeout-signal', 'redirect-error']) {
  test(`${probe}: destino fijo, JWT ficticio, controles y salida sin secretos`, async () => {
    let count = 0
    const api = createDiagnosticWorker(async (input, init) => {
      count++
      expect(String(input)).toBe(`${env.SUPABASE_URL}/auth/v1/user`)
      expect(init?.redirect).toBe(probe === 'redirect-error' ? 'error' : 'manual')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.cache).toBeUndefined()
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(probe === 'baseline' ? null : 'Bearer aaa.bbb.ccc')
      expect(headers.get('apikey')).toBe(probe === 'baseline' ? null : env.SUPABASE_PUBLISHABLE_KEY)
      expect(init?.body).toBeUndefined()
      return new Response('PRIVATE_BODY', { status: 403, headers: { 'x-sb-error-code': 'PRIVATE_HEADER' } })
    })
    const response = await api.fetch(request(probe), env)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ phase: 'fetch', upstream_status: 403, exception_type: null })
    expect(count).toBe(1)
    safeLogs()
  })
}

test('constructores sin red ni variables Supabase (Node acepta error; workerd lo rechaza)', async () => {
  let count = 0
  const api = createDiagnosticWorker(async () => { count++; throw new Error() })
  for (const probe of ['construct-manual', 'construct-error', 'construct-timeout']) {
    expect(await (await api.fetch(request(probe), { DIAGNOSTIC_ACCESS_KEY: env.DIAGNOSTIC_ACCESS_KEY })).json())
      .toMatchObject({ phase: 'request', upstream_status: null, exception_type: null })
  }
  expect(count).toBe(0)
  safeLogs()
})

for (const [index, value] of ['', 'not a URL', 'http://privateproject.supabase.co', 'https://evil.test',
  'https://privateproject.supabase.co.evil.test', 'https://privateproject.supabase.co/wrong',
  'https://privateproject.supabase.co?query=PRIVATE_BODY', 'https://user:pass@privateproject.supabase.co'].entries()) {
  test(`configuración rechazada caso ${index}`, async () => {
    let fetched = false
    const api = createDiagnosticWorker(async () => { fetched = true; throw new Error() })
    const response = await api.fetch(request('baseline'), { ...env, SUPABASE_URL: value })
    expect(await response.json()).toMatchObject({ phase: 'config', exception_type: 'TypeError' })
    expect(fetched).toBe(false)
    safeLogs()
  })
}

for (const [index, key] of ['sb_publishable_fake\r\nPRIVATE_HEADER', 'sb_publishable_\u0100PRIVATE_HEADER', 'sb_secret_wrong'].entries()) {
  test(`encabezado/configuración de clave inválida caso ${index}, sin fetch`, async () => {
    let fetched = false
    const api = createDiagnosticWorker(async () => { fetched = true; throw new Error() })
    expect(await (await api.fetch(request('headers-object'), { ...env, SUPABASE_PUBLISHABLE_KEY: key })).json())
      .toMatchObject({ phase: 'headers', exception_type: 'TypeError' })
    expect(fetched).toBe(false)
    safeLogs()
  })
}

test('fallo de AbortSignal.timeout se localiza en signal y no hace fetch', async () => {
  const saved = AbortSignal.timeout
  let fetched = false
  AbortSignal.timeout = () => { throw new TypeError('PRIVATE_MESSAGE') }
  try {
    const api = createDiagnosticWorker(async () => { fetched = true; throw new Error() })
    expect(await (await api.fetch(request('timeout-signal'), env)).json())
      .toMatchObject({ phase: 'signal', exception_type: 'TypeError', timeout: false })
    expect(fetched).toBe(false)
    safeLogs()
  } finally { AbortSignal.timeout = saved }
})

test('redirecciones se devuelven sin seguir Location ni leer cuerpo', async () => {
  let count = 0
  const api = createDiagnosticWorker(async () => {
    count++
    return new Response('PRIVATE_BODY', { status: 302, headers: { Location: 'https://evil.test/PRIVATE_HEADER' } })
  })
  expect(await (await api.fetch(request('headers-instance'), env)).json())
    .toMatchObject({ phase: 'fetch', upstream_status: 302 })
  expect(count).toBe(1)
  safeLogs()
})

for (const [index, cause, normalized] of [
  [0, new TypeError('PRIVATE_MESSAGE'), 'TypeError'],
  [1, new DOMException('PRIVATE_MESSAGE', 'TimeoutError'), 'TimeoutError'],
  [2, { name: 'PRIVATE_EXCEPTION_NAME', message: 'PRIVATE_MESSAGE', stack: 'PRIVATE_BODY' }, 'UnknownError'],
] as const) {
  test(`excepción saneada caso ${index}`, async () => {
    const api = createDiagnosticWorker(async () => { throw cause })
    expect(await (await api.fetch(request('timeout-signal'), env)).json())
      .toMatchObject({ phase: 'fetch', upstream_status: null, exception_type: normalized, timeout: index === 1 })
    safeLogs()
  })
}

test('cerrado sin clave, ante Origin, método/ruta/query inválidos; nunca fetch', async () => {
  let count = 0
  const api = createDiagnosticWorker(async () => { count++; throw new Error() })
  expect((await api.fetch(request('baseline'), {})).status).toBe(403)
  expect((await api.fetch(request('baseline'), { ...env, DIAGNOSTIC_ACCESS_KEY:'REPLACE_WITH_RANDOM_DIAGNOSTIC_ACCESS_KEY' })).status).toBe(403)
  expect((await api.fetch(request('baseline', { headers: { 'X-Diagnostic-Key': 'wrong' } }), env)).status).toBe(403)
  expect((await api.fetch(request('baseline', { headers: { Origin: 'https://evil.test' } }), env)).status).toBe(403)
  expect((await api.fetch(request('baseline', { method: 'GET' }), env)).status).toBe(405)
  expect((await api.fetch(request('baseline?target=https://evil.test'), env)).status).toBe(404)
  expect((await api.fetch(request('other'), env)).status).toBe(404)
  expect(count).toBe(0)
  expect(logs).toEqual([])
})
