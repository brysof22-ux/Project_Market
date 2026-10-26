import { test, expect } from '@playwright/test'
import { createWorker, type Env } from '../../worker/api/src'
import { canAccessRoute, canPerform, homeRoute } from '../../shared/permissions'
import { recentlyAuthenticated } from '../../worker/api/src/recent-auth'

const actor = '10000000-0000-0000-0000-000000000001'
const env: Env = { SUPABASE_URL: 'https://unit.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', ALLOWED_ORIGIN: 'https://project-market.pages.dev', MEDIA: {} }
const routes = ['dashboard', 'pos', 'inventario', 'estadisticas', 'contabilidad', 'clientes', 'proveedores', 'creditos', 'auditoria', 'configuracion']
const forbidden = [
  ['catalog', 'product.save'], ['catalog', 'inventory.adjust'], ['catalog', 'inventory.history'],
  ['catalog', 'customer.save'], ['catalog', 'supplier.save'], ['catalog', 'directories.list'], ['catalog', 'media.attach'],
  ['operations', 'report'], ['operations', 'cash.move'], ['operations', 'sale.return'], ['operations', 'credit.limit'],
  ['operations', 'users.list'], ['operations', 'audit.list'], ['operations', 'user.save'],
  ['operations', 'settings.save'], ['operations', 'reset.preview'], ['operations', 'reset.confirm'], ['operations', 'periods.list'],
  ['operations', 'periods.detail'], ['operations', 'credits.list'], ['operations', 'credit.history'], ['operations', 'credit.receipt'],
] as const

for (const role of ['admin', 'cashier', 'supervisor'] as const) {
  test(`navegación ${role}: permisos explícitos y Supervisor no hereda acceso`, () => {
    for (const route of routes) expect(canAccessRoute(role, route)).toBe(role === 'admin' || (role === 'cashier' && ['pos', 'creditos'].includes(route)))
    expect(homeRoute(role)).toBe(role === 'admin' ? 'dashboard' : role === 'cashier' ? 'pos' : '')
    expect(canAccessRoute(role, 'unknown')).toBe(false)
    expect(canPerform(role, 'operations', 'unknown')).toBe(false)
  })
}

for (const [section, action] of forbidden) {
  test(`HTTP directo cajero bloquea ${section}/${action} antes de RPC`, async () => {
    let calls = 0
    const api = createWorker(async (input) => {
      calls++
      return Response.json(String(input).endsWith('/user') ? { id: actor }
        : [{ id: actor, display_name: 'Cajero', role: 'cashier', active: true, can_expenses: true }])
    })
    const response = await api.fetch(new Request(`https://api.test/api/${section}`, {
      method: 'POST', headers: { Authorization: 'Bearer fake.payload.signature', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, data: { role: 'admin', can_expenses: true }, key: 'must-not-execute' }),
    }), env)
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('FORBIDDEN')
    expect(calls).toBe(2)
  })
}

for (const action of ['bootstrap', 'cash.open', 'cash.close', 'sale.confirm', 'debt.receipt', 'debts.list', 'debt.detail']) {
  test(`cajero autorizado para ${action}; Supervisor bloqueado`, () => {
    expect(canPerform('cashier', 'operations', action)).toBe(true)
    expect(canPerform('supervisor', 'operations', action)).toBe(false)
  })
}

const now = 1_800_000_000_000
const jwtRequest = (claims: unknown) => new Request('https://api.test/api/operations', {
  headers: { Authorization: `Bearer eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fake_signature` },
})
const fresh = { sub: actor, session_id: '10000000-0000-0000-0000-000000000002', iat: now / 1000,
  amr: [{ method: 'password', timestamp: now / 1000 - 20 }] }

test('reinicio: AMR reciente de sesión verificada; iat/refresco solos no autorizan', () => {
  expect(recentlyAuthenticated(jwtRequest(fresh), actor, now)).toBe(true)
  for (const claims of [
    { ...fresh, amr: [{ method: 'token_refresh', timestamp: now / 1000 }] },
    { ...fresh, amr: [{ method: 'password', timestamp: now / 1000 - 301 }] },
    { ...fresh, amr: [{ method: 'password', timestamp: now / 1000 + 60 }] },
    { ...fresh, amr: [{ method: 'password', timestamp: String(now / 1000) }] },
    { ...fresh, amr: [] }, { ...fresh, amr: undefined }, { ...fresh, sub: 'another-user' }, { ...fresh, session_id: undefined },
  ]) expect(recentlyAuthenticated(jwtRequest(claims), actor, now)).toBe(false)
})

test('reinicio HTTP no acepta reciente_auth enviado por cliente ni JWT solo refrescado', async () => {
  let calls = 0
  const api = createWorker(async (input) => {
    calls++
    return Response.json(String(input).endsWith('/user') ? { id: actor } : [{ id: actor, display_name: 'Admin', role: 'admin', active: true }])
  })
  const request = jwtRequest({ ...fresh, amr: [{ method: 'token_refresh', timestamp: Math.floor(Date.now() / 1000) }] })
  const response = await api.fetch(new Request(request, { method: 'POST',
    headers: { Authorization: request.headers.get('Authorization')!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reset.confirm', data: { recent_auth: true }, key: 'reset-no' }),
  }), env)
  expect(response.status).toBe(403)
  expect((await response.json()).error.code).toBe('RECENT_AUTH_REQUIRED')
  expect(calls).toBe(2)
})

for (const [state, message, expected] of [
  ['55P03', 'OPERATION_IN_PROGRESS', 422], ['XX000', 'OPERATION_IN_PROGRESS', 503],
  ['55P03', 'PRIVATE_EXCEPTION_DETAIL', 503],
] as const) {
  test(`contención PostgREST HTTP500 ${state}/${message}: normaliza sólo el par exacto`, async () => {
    const api = createWorker(async (input) => {
      const url = String(input)
      if (url.endsWith('/user')) return Response.json({ id: actor })
      if (url.endsWith('/cai_current_profile')) return Response.json([{ id: actor, display_name: 'Cajero', role: 'cashier', active: true }])
      return Response.json({ code: state, message, details: 'PRIVATE_BODY', hint: 'fake.payload.signature' }, { status: 500 })
    })
    const response = await api.fetch(new Request('https://api.test/api/operations', {
      method: 'POST', headers: { Authorization: 'Bearer fake.payload.signature', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'bootstrap', data: {} }),
    }), env)
    expect(response.status).toBe(expected)
    const body = await response.text()
    expect(body).not.toContain('PRIVATE_')
    expect(body).not.toContain('fake.payload.signature')
    expect(JSON.parse(body).error.code).toBe(expected === 422 ? 'OPERATION_IN_PROGRESS' : 'CATALOG_UNAVAILABLE')
  })
}
