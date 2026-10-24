import { test, expect } from '@playwright/test'
import { createApiClient, ApiError } from '../../src/lib/api-client'

const profile = { id: '10000000-0000-0000-0000-000000000001', display_name: 'Admin de prueba', role: 'admin', active: true }

test('cliente obtiene sesión y adjunta el token actual sin enviar identificadores', async () => {
  let captured: { url: string; init: RequestInit } | undefined
  const api = createApiClient({ baseUrl: 'https://api.test', getSession: async () => ({ access_token: 'current-access-token' }),
    fetcher: async (input, init = {}) => { captured = { url: String(input), init }; return Response.json({ ...profile, password: 'must-not-return' }) } })
  expect(await api.getMe()).toEqual(profile)
  expect(captured?.url).toBe('https://api.test/api/me')
  expect(new Headers(captured?.init.headers).get('Authorization')).toBe('Bearer current-access-token')
  expect(captured?.init.body).toBeUndefined()
  expect(captured?.init.credentials).toBe('omit')
})
test('sin sesión no envía ninguna solicitud', async () => {
  let called = false
  const api = createApiClient({ baseUrl: 'https://api.test', getSession: async () => null,
    fetcher: async () => { called = true; return Response.json(profile) } })
  await expect(api.getMe()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' })
  expect(called).toBe(false)
})
for (const status of [401, 403, 500]) {
  test(`cliente maneja ${status} sin propagar cuerpos sensibles`, async () => {
    const api = createApiClient({ baseUrl: 'https://api.test', getSession: async () => ({ access_token: 'test-token' }),
      fetcher: async () => new Response('token=DO_NOT_LEAK password=DO_NOT_LEAK', { status }) })
    try { await api.getMe(); throw new Error('Expected API failure') }
    catch (cause) {
      expect(cause).toBeInstanceOf(ApiError)
      expect((cause as ApiError).status).toBe(status === 500 ? 503 : status)
      expect((cause as Error).message).not.toContain('DO_NOT_LEAK')
    }
  })
}
test('rechaza respuesta inválida o perfil inactivo', async () => {
  for (const body of [{ arbitrary: true }, { ...profile, active: false }]) {
    const api = createApiClient({ baseUrl: 'https://api.test', getSession: async () => ({ access_token: 'test-token' }), fetcher: async () => Response.json(body) })
    await expect(api.getMe()).rejects.toBeInstanceOf(ApiError)
  }
})
test('rechaza configuración insegura y fallos de red', async () => {
  for (const baseUrl of ['', 'http://api.test', 'https://user:password@api.test', 'https://api.test/?token=secret']) {
    const api = createApiClient({ baseUrl, getSession: async () => ({ access_token: 'test-token' }) })
    await expect(api.getMe()).rejects.toMatchObject({ code: 'API_CONFIGURATION' })
  }
  const api = createApiClient({ baseUrl: 'https://api.test', getSession: async () => ({ access_token: 'test-token' }), fetcher: async () => { throw new Error('private-network-details') } })
  await expect(api.getMe()).rejects.toMatchObject({ code: 'API_UNAVAILABLE' })
})

test('errores operativos solo muestran mensajes propios para códigos conocidos', async () => {
  for (const code of ['INSUFFICIENT_STOCK','__proto__','PRIVATE_ERROR']) {
    const api = createApiClient({baseUrl:'https://api.test',getSession:async () => ({access_token:'fake-token'}),
      fetcher:async () => Response.json({error:{code,message:'DO_NOT_LEAK'}},{status:422})})
    try { await api.operations('cash.open',{},'key'); throw new Error('Expected rejection') }
    catch (cause) {
      expect(cause).toBeInstanceOf(ApiError)
      expect((cause as Error).message).not.toContain('DO_NOT_LEAK')
      expect((cause as ApiError).code).toBe(code==='INSUFFICIENT_STOCK' ? code : 'INVALID_OPERATION')
    }
  }
})

test('JSON exitoso incompatible no confirma ventas ni se interpreta como catálogo o reporte', async () => {
  const api = createApiClient({baseUrl:'https://api.test',getSession:async () => ({access_token:'fake-token'}),fetcher:async () => Response.json({status:'ok',message:'DO_NOT_LEAK'})})
  await expect(api.catalog('products.list',{})).rejects.toMatchObject({status:502,code:'INVALID_RESPONSE'})
  await expect(api.operations('report',{})).rejects.toMatchObject({status:502,code:'INVALID_RESPONSE'})
  await expect(api.operations('sale.confirm',{},'same-key')).rejects.toMatchObject({status:502,code:'INVALID_RESPONSE'})
})
