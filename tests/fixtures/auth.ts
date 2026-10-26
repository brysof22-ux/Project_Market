import { test as base, expect, type BrowserContext } from '@playwright/test'
import { businessFixture } from './business'
export type { Page } from '@playwright/test'
export { expect }

export const storageKey = 'cai-market:auth:v1'
export const authUser = {
  id: '10000000-0000-0000-0000-000000000001',
  aud: 'authenticated', role: 'authenticated', email: 'admin@cai.test',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [],
}
export function fakeSession(expiresIn = 3600) {
  const exp = Math.floor(Date.now() / 1000) + expiresIn
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: authUser.id, aud: 'authenticated', role: 'authenticated', exp,
      session_id: '90000000-0000-4000-8000-000000000001', amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })}.fake_signature`,
    refresh_token: 'fake-refresh-token', token_type: 'bearer', expires_in: expiresIn, expires_at: exp, user: authUser,
  }
}
export async function mockAuth(context: BrowserContext, options: {
  passwordError?: boolean; userError?: boolean; refreshError?: boolean; logoutError?: boolean; expiresIn?: number
  profileStatus?: number; profile?: unknown
} = {}) {
  const calls: string[] = []
  const business = businessFixture(context, authUser.id,
    options.profile && typeof options.profile === 'object' && 'role' in options.profile ? String(options.profile.role) : 'admin')
  await context.route('https://cai-api-test.invalid/**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/me') {
      const binary = new URL(route.request().url()).pathname.endsWith('/image')
      const raw = route.request().postDataBuffer()
      const body = binary && raw ? new Uint8Array(raw).buffer : route.request().postData()
      const response = await business(route.request().url(), { method:route.request().method(),headers:route.request().headers(),body })
      const responseBody = response.headers.get('Content-Type')?.startsWith('image/')
        ? Buffer.from(await response.arrayBuffer()) : await response.text()
      return route.fulfill({ status:response.status,headers:Object.fromEntries(response.headers),body:responseBody })
    }
    calls.push(`${route.request().method()} api/me`)
    await route.fulfill({ status: options.profileStatus ?? 200, headers: { 'access-control-allow-origin': '*' },
      json: options.profile ?? { id: authUser.id, display_name: 'Administrador de prueba', role: 'admin', active: true } })
  })
  await context.route('https://cai-auth-test.supabase.co/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const endpoint = url.pathname.replace('/auth/v1/', '')
    calls.push(`${request.method()} ${endpoint}${url.search}`)
    const headers = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Supabase-Api-Version', 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (endpoint === 'token') {
      const refresh = url.searchParams.get('grant_type') === 'refresh_token'
      if ((refresh && options.refreshError) || (!refresh && options.passwordError)) {
        return route.fulfill({ status: 400, headers, json: { code: refresh ? 'refresh_token_not_found' : 'invalid_credentials', message: 'Invalid test credentials' } })
      }
      return route.fulfill({ status: 200, headers, json: fakeSession(options.expiresIn) })
    }
    if (endpoint === 'user') return route.fulfill({ status: options.userError ? 401 : 200, headers,
      json: options.userError ? { code: 'bad_jwt', message: 'Invalid test JWT' } : authUser })
    if (endpoint === 'logout') return route.fulfill({ status: options.logoutError ? 500 : 204, headers,
      body: options.logoutError ? JSON.stringify({ message: 'Test server unavailable' }) : '' })
    // Fail closed for database/unknown requests. Tests never reach a live project.
    return route.fulfill({ status: 403, headers, json: { message: 'Unexpected test endpoint' } })
  })
  return calls
}

// Existing visual tests run with an SDK session and a mocked Auth server, not
// a production authentication bypass or a VITE flag that disables route guards.
export const test = base.extend<{ authenticatedFixture: void }>({
  authenticatedFixture: [async ({ context }, use) => {
    await mockAuth(context)
    await context.addInitScript(({ key, session }) => {
      if (!sessionStorage.getItem('cai:auth-test-seeded')) {
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(session))
        sessionStorage.setItem('cai:auth-test-seeded', '1')
      }
    }, { key: storageKey, session: fakeSession() })
    await use()
  }, { auto: true }],
})
