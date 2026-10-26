// Local workerd regression. Every Worker outbound request is intercepted;
// no Supabase credentials, production services or business data are used.
// Validated with Wrangler 4.152.0 / Miniflare 5.20261019.2-beta.
// Optional argument: absolute node_modules directory containing Wrangler's
// already-installed miniflare and esbuild dependencies. Nothing is installed.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

async function toolchain() {
  const candidates = process.argv[2] ? [resolve(process.argv[2])] : [resolve('node_modules')]
  if (!process.argv[2]) {
    for (const entry of await readdir('.cache/npm/_npx', { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) candidates.push(resolve('.cache/npm/_npx', entry.name, 'node_modules'))
    }
  }
  for (const directory of candidates) {
    const require = createRequire(join(directory, '__cai_runtime_check__.cjs'))
    try { return { mf: require('miniflare'), esbuild: require('esbuild') } } catch { /* next installed candidate */ }
  }
  throw new Error('Install/use the approved Wrangler toolchain first; pass its node_modules path.')
}

const { mf: { Miniflare, Log, LogLevel, Request: MockRequest, Response: MockResponse }, esbuild } = await toolchain()
const configuration = JSON.parse(await readFile('worker/api/wrangler.jsonc', 'utf8'))
const bundle = await esbuild.build({ entryPoints: ['worker/api/src/index.ts'], bundle: true,
  format: 'esm', platform: 'browser', target: 'es2023', write: false, logLevel: 'silent' })
const origin = 'https://project-market.pages.dev'
const jwt = 'RUNTIME_FAKE.JWT.SIGNATURE'
const key = 'sb_publishable_RUNTIME_FAKE_ONLY'
const profile = { id: '10000000-0000-0000-0000-000000000001', display_name: 'Runtime fixture', role: 'admin', active: true }
const privateMarker = 'PRIVATE_UPSTREAM_SENTINEL'
const logs = []
const calls = []
let scenario = 'success'
let operation = null
const results = []

class CapturedLog extends Log {
  constructor() { super(LogLevel.VERBOSE) }
  logWithLevel(level, message) { logs.push(String(message)) }
  logReady() {}
}

// This handler replaces the default network service for every fetch().
// Unknown hosts and paths fail closed, without using a Node fetch fallback.
async function outbound(request) {
  const url = new URL(request.url)
  assert.equal(url.origin, 'https://runtime-fixture.invalid')
  assert.equal(url.search, '')
  assert.equal(request.headers.get('Authorization'), `Bearer ${jwt}`)
  assert.equal(request.headers.get('apikey'), key)
  calls.push(url.pathname)
  const json = (value, status = 200) => MockResponse.json(value, { status })
  if (url.pathname === '/auth/v1/user') {
    assert.equal(request.method, 'GET')
    if (scenario === 'bad-jwt') return json({ message: privateMarker }, 403)
    if (scenario === 'auth-redirect') return new MockResponse(privateMarker, { status: 302, headers: { Location: 'https://forbidden.invalid/collect' } })
    return json({ id: profile.id, email: privateMarker })
  }
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.get('Content-Profile'), 'public')
  assert.equal(request.headers.get('Accept-Profile'), 'public')
  const body = await request.json()
  if (url.pathname === '/rest/v1/rpc/cai_current_profile') {
    assert.deepEqual(body, {})
    if (scenario === 'profile-redirect') return new MockResponse(privateMarker, { status: 307, headers: { Location: 'https://forbidden.invalid/collect' } })
    if (scenario === 'foreign-profile') return json([{ ...profile, id: '20000000-0000-0000-0000-000000000002' }])
    return json([profile])
  }
  assert.ok(operation)
  assert.equal(url.pathname, `/rest/v1/rpc/${operation.rpc}`)
  assert.deepEqual(body, operation.expected)
  if (scenario === 'business-redirect') return new MockResponse(privateMarker, { status: 308, headers: { Location: 'https://forbidden.invalid/collect' } })
  return json({ fixture: true })
}

const probes = `export default { async fetch(request) {
  const type = new URL(request.url).pathname.slice(1);
  try {
    const signal = type === 'timeout' ? AbortSignal.timeout(10000) : undefined;
    new Request('https://construct-only.invalid/', { redirect: type === 'error' ? 'error' : 'manual', signal });
    return Response.json({ constructed: true });
  } catch (cause) { return Response.json({ constructed: false, exception: cause.name }); }
} };`

const runtime = new Miniflare({
  log: new CapturedLog(), telemetry: { enabled: false },
  handleStructuredLogs: (entry) => logs.push(entry.message),
  workers: [
    { config: { name: 'cai-runtime-api-fixture',
      compatibilityDate: configuration.compatibility_date,
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
      env: Object.fromEntries(Object.entries({ SUPABASE_URL: 'https://runtime-fixture.invalid', SUPABASE_PUBLISHABLE_KEY: key, ALLOWED_ORIGIN: origin })
        .map(([name, value]) => [name, { type: 'text', value }])) },
      dev: { outboundService: { type: 'fetcher', handler: outbound }, unsafeRegisterWorker: false } },
    { config: { name: 'cai-runtime-constructor-fixture',
      compatibilityDate: configuration.compatibility_date,
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: probes } } } },
      dev: { outboundService: { type: 'fetcher', handler: async () => { throw new Error('Construction probes must never perform I/O') } }, unsafeRegisterWorker: false } },
  ],
})

async function checked(name, execute) {
  calls.length = 0
  await execute()
  results.push({ name, passed: true })
}

function request(path = '/api/me', options = {}) {
  return new MockRequest(`https://local-api.invalid${path}`, { ...options, headers: {
    Authorization: `Bearer ${jwt}`, Origin: origin, ...(options.headers ?? {}),
  } })
}

try {
  await runtime.ready
  // Dispatch directly to the first local Worker. getWorker() uses a /cdn-cgi
  // proxy with its own Origin policy, which would mask the API's CORS check.
  const api = { fetch: runtime.dispatchFetch }
  const constructor = await runtime.getWorker('cai-runtime-constructor-fixture')
  await checked('redirect:error fails immediately in workerd', async () => {
    const response = await constructor.fetch('https://local-probe.invalid/error')
    assert.deepEqual(await response.json(), { constructed: false, exception: 'TypeError' })
  })
  for (const type of ['manual', 'timeout']) await checked(`construct ${type}`, async () => {
    const response = await constructor.fetch(`https://local-probe.invalid/${type}`)
    assert.deepEqual(await response.json(), { constructed: true })
  })
  await checked('Auth and profile through native workerd fetch', async () => {
    const response = await api.fetch(request())
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), profile)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin)
    assert.deepEqual(calls, ['/auth/v1/user', '/rest/v1/rpc/cai_current_profile'])
  })
  for (const [name, expectedStatus, expectedCode, expectedCalls] of [
    ['bad-jwt', 401, 'UNAUTHORIZED', 1],
    ['auth-redirect', 503, 'AUTH_UNAVAILABLE', 1],
    ['profile-redirect', 503, 'PROFILE_UNAVAILABLE', 2],
    ['foreign-profile', 502, 'INVALID_UPSTREAM_RESPONSE', 2],
  ]) await checked(name, async () => {
    scenario = name
    const response = await api.fetch(request())
    assert.equal(response.status, expectedStatus)
    assert.equal((await response.json()).error.code, expectedCode)
    assert.equal(calls.length, expectedCalls)
  })
  scenario = 'success'
  for (const [section, action, rpc, data] of [
    ['catalog', 'products.list', 'cai_catalog', { limit: 20 }],
    ['operations', 'sales.list', 'cai_operations', { limit: 20 }],
    ['operations', 'report', 'cai_report', { from: '2026-10-19', to: '2026-10-25' }],
  ]) await checked(`native fetch to ${rpc}`, async () => {
    operation = { rpc, expected: action === 'report' ? { p_data: data } : { p_action: action, p_data: data, p_key: 'runtime-idempotency' } }
    const response = await api.fetch(request(`/api/${section}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, data, key: 'runtime-idempotency' }),
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { fixture: true })
    assert.deepEqual(calls, ['/auth/v1/user', '/rest/v1/rpc/cai_current_profile', `/rest/v1/rpc/${rpc}`])
  })
  await checked('business redirect rejected without following Location', async () => {
    scenario = 'business-redirect'
    const response = await api.fetch(request('/api/operations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'report', data: operation.expected.p_data }),
    }))
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error.code, 'CATALOG_UNAVAILABLE')
    assert.equal(calls.length, 3)
  })
  await checked('CORS and anonymous request stop before upstream', async () => {
    const denied = await api.fetch(request('/api/me', { headers: { Origin: 'https://evil.invalid' } }))
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null)
    const anonymous = await api.fetch(new MockRequest('https://local-api.invalid/api/me', { headers: { Origin: origin } }))
    assert.equal(anonymous.status, 401)
    assert.equal(calls.length, 0)
  })
  await checked('runtime diagnostics contain no sensitive fixture data', async () => {
    const emitted = logs.join('\n')
    assert.ok(emitted.includes('auth_diagnostic'), 'Runtime logs must actually be captured')
    for (const sentinel of [jwt, key, privateMarker, profile.id, profile.display_name, 'runtime-fixture.invalid']) assert.ok(!emitted.includes(sentinel))
  })
  console.log(JSON.stringify({ status: 'PASS', runtime: 'workerd', compatibilityDate: configuration.compatibility_date,
    remoteRequests: 0, productionCredentials: false, tests: results }, null, 2))
} finally {
  await runtime.dispose()
}
