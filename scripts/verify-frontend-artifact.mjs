// Browser verification of the production artifact with Pages headers applied.
// Every non-loopback request is intercepted; only synthetic health reads pass.
// No session, credential, business RPC or remote service is used.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { chromium } from '@playwright/test'

const root = resolve('dist')
const headerText = await readFile(resolve(root, '_headers'), 'utf8')
const sourceHeaders = await readFile('public/_headers', 'utf8')
assert.equal(headerText, sourceHeaders, 'dist must contain the current Pages headers')
const headers = new Map()
let universal = false
for (const line of headerText.split(/\r?\n/)) {
  if (!line.trim() || line.trim().startsWith('#')) continue
  if (!/^\s/.test(line)) { universal = line.trim() === '/*'; continue }
  if (!universal) continue
  const colon = line.indexOf(':')
  assert.ok(colon > 0, 'Malformed Pages header')
  headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
}
const policy = headers.get('content-security-policy')
assert.ok(policy)
const directives = new Map(policy.split(';').map(value => value.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...values]) => [name, values]))
const supabase = 'https://sauoekefntzxhqxycdgo.supabase.co'
const worker = 'https://cai-market-api.brysof22.workers.dev'
assert.deepEqual(directives.get('connect-src'), ["'self'", supabase, worker])
assert.deepEqual(directives.get('script-src'), ["'self'"])
assert.deepEqual(directives.get('object-src'), ["'none'"])
assert.deepEqual(directives.get('frame-ancestors'), ["'none'"])
assert.equal(headers.get('x-content-type-options'), 'nosniff')
assert.equal(headers.get('x-frame-options'), 'DENY')
assert.equal(headers.get('referrer-policy'), 'no-referrer')
assert.equal(headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()')

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = createServer(async (request, response) => {
  for (const [name, value] of headers) response.setHeader(name, value)
  response.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path))
    if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403); response.end(); return }
    if (!(await stat(file)).isFile()) { response.writeHead(404); response.end(); return }
    response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream')
    const contents = await readFile(file)
    response.writeHead(200)
    response.end(request.method === 'HEAD' ? undefined : contents)
  } catch { response.writeHead(404); response.end() }
})
let browser
const checks = []
const intercepted = { workerHealth: 0, supabaseHealth: 0, otherRemote: 0 }
async function checked(name, execute) { await execute(); checks.push({ name, passed: true }) }
try {
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === origin) return route.continue()
    if (request.method() === 'GET' && url.href === worker + '/health') {
      intercepted.workerHealth++
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin, 'Cache-Control': 'no-store' }, body: '{"status":"ok"}' })
    }
    if (request.method() === 'GET' && url.href === supabase + '/auth/v1/health') {
      intercepted.supabaseHealth++
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin, 'Cache-Control': 'no-store' }, body: '{"status":"fixture"}' })
    }
    intercepted.otherRemote++
    return route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', () => pageErrors.push('PAGE_ERROR'))
  await page.addInitScript(() => {
    window.__caiArtifactCsp = []
    document.addEventListener('securitypolicyviolation', event => {
      window.__caiArtifactCsp.push({ directive: event.violatedDirective, blocked: event.blockedURI })
    })
  })
  await checked('production HTML serves the exact Pages security headers', async () => {
    const response = await page.goto(origin)
    assert.equal(response.status(), 200)
    const received = await response.allHeaders()
    for (const [name, value] of headers) assert.equal(received[name], value)
  })
  await checked('self-hosted production scripts render login without a session', async () => {
    await page.getByRole('heading', { name: 'Bienvenido a tu tienda' }).waitFor()
    assert.equal(await page.locator('.app-shell').count(), 0)
    assert.equal(await page.getByRole('navigation').count(), 0)
  })
  await checked('all private hash routes remain behind login', async () => {
    for (const route of ['dashboard', 'pos', 'inventario', 'estadisticas', 'contabilidad', 'clientes', 'proveedores', 'creditos', 'auditoria', 'configuracion']) {
      await page.goto(`${origin}/#/${route}`)
      await page.getByRole('heading', { name: 'Bienvenido a tu tienda' }).waitFor()
      assert.equal(await page.locator('.app-shell').count(), 0)
    }
  })
  await checked('connect-src permits the Worker health origin with intercepted CORS', async () => {
    const response = await page.evaluate(async url => {
      const result = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store' })
      return { status: result.status, value: await result.json() }
    }, worker + '/health')
    assert.deepEqual(response, { status: 200, value: { status: 'ok' } })
    assert.equal(intercepted.workerHealth, 1)
  })
  await checked('connect-src permits the Supabase health origin with intercepted CORS', async () => {
    const response = await page.evaluate(async url => {
      const result = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store' })
      return { status: result.status, value: await result.json() }
    }, supabase + '/auth/v1/health')
    assert.deepEqual(response, { status: 200, value: { status: 'fixture' } })
    assert.equal(intercepted.supabaseHealth, 1)
  })
  await checked('connect-src blocks a third-party origin before outbound routing', async () => {
    const blocked = await page.evaluate(async () => {
      try { await fetch('https://blocked-cai-artifact.invalid/health', { credentials: 'omit' }); return false }
      catch { return true }
    })
    assert.equal(blocked, true)
    await page.waitForFunction(() => window.__caiArtifactCsp.some(event => event.directive === 'connect-src' && event.blocked === 'https://blocked-cai-artifact.invalid/health'))
    assert.equal(intercepted.otherRemote, 0, 'CSP must block before any remote request needs interception')
  })
  await checked('no unexpected runtime error, Auth call or business request', async () => {
    assert.deepEqual(pageErrors, [])
    assert.equal(intercepted.otherRemote, 0)
    assert.equal(await page.locator('.app-shell').count(), 0)
    const violations = await page.evaluate(() => window.__caiArtifactCsp)
    assert.ok(violations.length > 0)
    assert.ok(violations.every(event => event.directive === 'connect-src' && event.blocked === 'https://blocked-cai-artifact.invalid/health'))
  })
  console.log(JSON.stringify({ status: 'PASS', scope: 'local-production-artifact-csp', checks, remoteRequests: 0,
    interceptedHealthFixtures: intercepted.workerHealth + intercepted.supabaseHealth, authenticatedSession: false,
    businessOperations: 0, note: 'Health fixtures prove browser CSP allowance only; production CORS/connectivity is verified separately.' }, null, 2))
} finally {
  if (browser) await browser.close()
  await new Promise(resolve => server.close(resolve))
}
