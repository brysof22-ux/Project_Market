// Read-only public probes. Never accepts, stores or prints a real JWT.
const api = 'https://cai-market-api.brysof22.workers.dev'
const origin = 'https://project-market.pages.dev'
const probes = [
  { name: 'health', path: '/health', status: 200, body: (value) => value?.status === 'ok' && Object.keys(value).length === 1 },
  { name: 'missing-token', path: '/api/me', status: 401, headers: { Origin: origin } },
  { name: 'invalid-token', path: '/api/me', status: 401, headers: { Origin: origin, Authorization: 'Bearer e30.e30.invalid_signature' } },
  { name: 'allowed-preflight', path: '/api/me', status: 204, method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } },
  { name: 'rejected-origin', path: '/api/me', status: 403, headers: { Origin: 'https://untrusted.example' } },
]
const results = []
for (const probe of probes) {
  try {
    const response = await fetch(`${api}${probe.path}`, {
      method: probe.method ?? 'GET', headers: probe.headers,
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    })
    const type = response.headers.get('content-type') ?? ''
    let value
    if (type.includes('application/json')) { try { value = await response.json() } catch { /* fail contract below */ } }
    else await response.body?.cancel()
    const cors = response.headers.get('access-control-allow-origin')
    const isPreflight = probe.method === 'OPTIONS'
    const corsOk = probe.headers?.Origin === origin ? cors === origin : cors === null
    const bodyOk = isPreflight ? response.headers.get('access-control-allow-methods') === 'GET, OPTIONS'
      && (response.headers.get('access-control-allow-headers') ?? '').toLowerCase().includes('authorization')
      : type.includes('application/json') && (probe.body ? probe.body(value) : typeof value?.error?.code === 'string')
    results.push({ name: probe.name, status: response.status, expectedStatus: probe.status, contentType: type,
      allowOrigin: cors, cacheControl: response.headers.get('cache-control'),
      passed: response.status === probe.status && corsOk && bodyOk && response.headers.get('cache-control') === 'no-store' })
  } catch { results.push({ name: probe.name, passed: false, error: 'NETWORK_OR_REDIRECT_ERROR' }) }
}
// Bundle markers are diagnostic only, not proof of correct runtime configuration.
let frontend
try {
  const page = await fetch(origin, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  const html = await page.text()
  const script = html.match(/<script[^>]+src="([^"]+\.js)"/)
  if (!page.ok || !script) throw new Error()
  const assetUrl = new URL(script[1], origin)
  if (assetUrl.origin !== origin) throw new Error()
  const asset = await fetch(assetUrl, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!asset.ok) throw new Error()
  const bundle = await asset.text()
  frontend = { status: page.status, includesExpectedApiUrl: bundle.includes(api), includesMeEndpoint: bundle.includes('/api/me') }
} catch { frontend = { error: 'FRONTEND_CHECK_FAILED' } }
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), api, frontendUrl: origin, results, frontend }, null, 2))
if (results.some((result) => !result.passed) || frontend.includesExpectedApiUrl !== true || frontend.includesMeEndpoint !== true) process.exitCode = 1
