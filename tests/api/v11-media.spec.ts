import { test, expect } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { createWorker, type Env } from '../../worker/api/src'
import { prepareImage, MAX_IMAGE_BYTES } from '../../worker/api/src/image-format'
import type { MediaBucket } from '../../worker/api/src/media'

const actor = '10000000-0000-0000-0000-000000000001'
const product = '30000000-0000-0000-0000-000000000001'
const period = '70000000-0000-0000-0000-000000000001'
const secret = 'DO_NOT_LEAK_UPSTREAM_TOKEN_OR_EXCEPTION'
const token = 'fake.payload.signature'
const envBase = { SUPABASE_URL: 'https://unit.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', ALLOWED_ORIGIN: 'https://project-market.pages.dev' }

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const value of bytes) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(kind: string, content: Uint8Array) {
  const result = Buffer.alloc(content.length + 12)
  result.writeUInt32BE(content.length, 0); result.write(kind, 4); result.set(content, 8)
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4)
  return result
}
function png(width = 1, text?: string) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(text ? [chunk('tEXt', Buffer.from(`Comment\0${text}`))] : []), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))])
}

function fixture(role = 'admin', options: { putFailure?: boolean; attachFailure?: boolean; lostCommit?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>()
  let metadata: Record<string, unknown> | null = null
  const actions: string[] = [], putKeys: string[] = []
  const bucket: MediaBucket = {
    async get(key) {
      const bytes = objects.get(key)
      return bytes ? { body: new Response(bytes.slice().buffer).body!, size: bytes.length, etag: 'opaque-etag' } : null
    },
    async put(key, data, configuration) {
      if (options.putFailure) throw new Error(secret)
      expect(configuration.onlyIf).toEqual({ etagDoesNotMatch: '*' })
      expect(configuration.httpMetadata.cacheControl).toBe('private, no-store')
      putKeys.push(key)
      const bytes = new Uint8Array(data); objects.set(key, bytes)
      return { etag: 'opaque-etag', size: bytes.length }
    },
  }
  const env: Env = { ...envBase, MEDIA: bucket }
  const api = createWorker(async (input, init) => {
    const url = String(input)
    expect(init?.redirect).toBe('manual')
    if (url.endsWith('/user')) return Response.json({ id: actor })
    if (url.endsWith('/cai_current_profile')) return Response.json([{ id: actor, display_name: 'Empleado', role, active: true }])
    expect(url).toBe(`${env.SUPABASE_URL}/rest/v1/rpc/cai_catalog`)
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`)
    const body = JSON.parse(String(init?.body)); actions.push(body.p_action)
    if (body.p_action === 'media.read') return Response.json(metadata)
    expect(body.p_action).toBe('media.attach')
    expect(body.p_data.expected_period).toBe(period)
    if (!options.attachFailure || options.lostCommit) metadata = body.p_data
    if (options.attachFailure || options.lostCommit) return Response.json({ message: secret }, { status: 500 })
    return Response.json({ image_id: body.p_data.image_id })
  })
  return { api, env, objects, actions, putKeys }
}

function request(method = 'POST', body: Uint8Array = png(), extra: Record<string, string> = {}) {
  return new Request(`https://api.test/api/products/${product}/image`, { method,
    headers: { Authorization: `Bearer ${token}`, Origin: envBase.ALLOWED_ORIGIN, 'Content-Type': 'image/png',
      'X-Expected-Image-Id': '', 'X-Expected-Period-Id': period, ...extra },
    ...(method === 'POST' ? { body: Uint8Array.from(body).buffer } : {}),
  })
}

test('fotografía privada: carga sanitizada, CAS, lectura autenticada y sin URLs/tokens', async () => {
  const { api, env, objects, putKeys } = fixture()
  const uploaded = await api.fetch(request('POST', png(1, secret)), env)
  expect(uploaded.status).toBe(201)
  const data = await uploaded.json()
  expect(data).toEqual({ image_id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  expect(putKeys).toEqual([`products/${product}/${data.image_id}`])
  expect(Buffer.from(objects.get(putKeys[0])!).toString()).not.toContain(secret)
  const downloaded = await api.fetch(request('GET'), env)
  expect(downloaded.status).toBe(200)
  expect(downloaded.headers.get('Content-Type')).toBe('image/png')
  expect(downloaded.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(downloaded.headers.get('Cache-Control')).toBe('no-store')
  expect(downloaded.headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN)
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(prepareImage(png(), 'image/png').bytes)
  const noAuth = await api.fetch(new Request(request('GET'), { headers: {} }), env)
  expect(noAuth.status).toBe(401)
})

for (const role of ['cashier', 'supervisor']) {
  test(`rol ${role}: no puede cargar fotografía ni escribir en R2`, async () => {
    const { api, env, actions, putKeys } = fixture(role)
    expect((await api.fetch(request(), env)).status).toBe(403)
    expect(actions).toHaveLength(0); expect(putKeys).toHaveLength(0)
  })
}

test('cajero puede consultar fotografía, sin fotografía devuelve 404', async () => {
  const { api, env, actions } = fixture('cashier')
  expect((await api.fetch(request('GET'), env)).status).toBe(404)
  expect(actions).toEqual(['media.read'])
})

test('conflicto CAS no almacena ni modifica la fotografía anterior', async () => {
  const { api, env, putKeys } = fixture()
  expect((await api.fetch(request(), env)).status).toBe(201)
  const conflict = await api.fetch(request(), env)
  expect(conflict.status).toBe(409)
  expect((await conflict.json()).error.code).toBe('IMAGE_CONFLICT')
  expect(putKeys).toHaveLength(1)
})

for (const [name, bytes, headers, status] of [
  ['SVG', Buffer.from('<svg onload="alert(1)"/>'), { 'Content-Type': 'image/svg+xml' }, 415],
  ['HTML MIME falso', Buffer.from('<html>not an image</html>'), {}, 415],
  ['PNG truncado', png().subarray(0, 30), {}, 415],
  ['PNG CRC incorrecto', Buffer.from(png().map((byte, index) => index === 30 ? byte ^ 1 : byte)), {}, 415],
  ['dimensiones excesivas', png(5000), {}, 415],
  ['tamaño stream excesivo', Buffer.alloc(MAX_IMAGE_BYTES + 1), { 'Content-Length': '1' }, 413],
  ['tamaño declarado excesivo', png(), { 'Content-Length': String(MAX_IMAGE_BYTES + 1) }, 413],
  ['período ausente', png(), { 'X-Expected-Period-Id': '' }, 422],
] as const) {
  test(`rechaza ${name} antes de R2`, async () => {
    const { api, env, putKeys } = fixture()
    expect((await api.fetch(request('POST', bytes, headers as Record<string, string>), env)).status).toBe(status)
    expect(putKeys).toHaveLength(0)
  })
}

test('R2 incompatible falla cerrado sin exponer claves, cuerpos ni excepciones', async () => {
  const { api, env } = fixture()
  const response = await api.fetch(request(), { ...env, MEDIA: {} })
  expect(response.status).toBe(503)
  expect((await response.json()).error.code).toBe('MEDIA_UNAVAILABLE')
})

test('fallo R2 o RPC: registros estructurados no contienen información sensible', async () => {
  const logs: string[] = []
  const log = console.log, error = console.error
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '))
  console.error = (...values: unknown[]) => logs.push(values.map(String).join(' '))
  try {
    for (const options of [{ putFailure: true }, { attachFailure: true }]) {
      const { api, env } = fixture('admin', options)
      const response = await api.fetch(request(), env)
      expect(response.status).toBe(503)
      for (const value of [secret, token, env.SUPABASE_PUBLISHABLE_KEY, env.SUPABASE_URL]) expect(await response.clone().text()).not.toContain(value)
    }
    for (const line of logs) {
      const row = JSON.parse(line)
      expect(Object.keys(row).sort()).toEqual(['duration_ms', 'event', 'exception_type', 'phase', 'timeout', 'upstream_status'])
      for (const value of [secret, token, envBase.SUPABASE_PUBLISHABLE_KEY, envBase.SUPABASE_URL]) expect(line).not.toContain(value)
    }
  } finally { console.log = log; console.error = error }
})

test('timeout después de COMMIT reconcilia la asociación; nunca borra una fotografía referenciada', async () => {
  const { api, env, objects } = fixture('admin', { lostCommit: true })
  const response = await api.fetch(request(), env)
  expect(response.status).toBe(200)
  expect(objects.size).toBe(1)
  expect((await api.fetch(request('GET'), env)).status).toBe(200)
})

test('CORS fotografías permite sólo origen y cabeceras previstas, sin ampliar /api/me', async () => {
  const { api, env, actions } = fixture()
  const headers = { Origin: env.ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type,x-expected-image-id,x-expected-period-id' }
  const response = await api.fetch(new Request(`https://api.test/api/products/${product}/image`, { method: 'OPTIONS', headers }), env)
  expect(response.status).toBe(204)
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS')
  expect(actions).toHaveLength(0)
  expect((await api.fetch(new Request('https://api.test/api/me', { method: 'OPTIONS', headers }), env)).status).toBe(405)
  expect((await api.fetch(request('GET', png(), { Origin: 'https://evil.test' }), env)).status).toBe(403)
})

for (const [path, mime] of [['tests/fixtures/qr-demo.jpg', 'image/jpeg'], ['tests/fixtures/qr-demo.webp', 'image/webp']] as const) {
  test(`valida raster real ${mime} y elimina metadata`, async () => {
    const source = await readFile(path)
    const result = prepareImage(source, mime)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
    expect(result.bytes.length).toBeLessThanOrEqual(source.length)
    expect(() => prepareImage(source.subarray(0, 15), mime)).toThrow()
  })
}
