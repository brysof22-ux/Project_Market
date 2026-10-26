import type { StaffProfile } from '../../../shared/profile'
import { CatalogError, catalogRpc } from './catalog'
import { MAX_IMAGE_BYTES, prepareImage } from './image-format'

export type MediaObject = { body: ReadableStream<Uint8Array>; size: number; etag: string }
export interface MediaBucket {
  get(key: string): Promise<MediaObject | null>
  put(key: string, value: ArrayBuffer, options: {
    httpMetadata: { contentType: string; cacheControl: string }; onlyIf: { etagDoesNotMatch: string }
  }): Promise<{ etag: string; size: number } | null>
}
type Upstream = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const mimeTypes = ['image/png', 'image/jpeg', 'image/webp']
const unavailable = (): never => { throw new CatalogError(503, 'MEDIA_UNAVAILABLE', 'El almacenamiento de fotografías no está disponible.') }
const notFound = (): never => { throw new CatalogError(404, 'IMAGE_NOT_FOUND', 'Este producto no tiene una fotografía disponible.') }

function bucket(value: unknown): MediaBucket {
  if (!value || typeof value !== 'object' || !('get' in value) || typeof value.get !== 'function'
    || !('put' in value) || typeof value.put !== 'function') unavailable()
  return value as MediaBucket
}

function metadata(value: unknown, productId: string) {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.image_id !== 'string' || !uuid.test(row.image_id)
    || row.object_key !== `products/${productId}/${row.image_id}` || typeof row.mime !== 'string'
    || !mimeTypes.includes(row.mime) || typeof row.size !== 'number'
    || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > MAX_IMAGE_BYTES) unavailable()
  return { imageId: row.image_id as string, key: row.object_key as string, mime: row.mime as string, size: row.size as number }
}

async function readImage(request: Request) {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
  if (!mimeTypes.includes(contentType)) throw new CatalogError(415, 'INVALID_IMAGE', 'Adjunta una fotografía PNG, JPEG o WebP.')
  const length = request.headers.get('Content-Length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) {
    throw new CatalogError(413, 'IMAGE_TOO_LARGE', 'La fotografía no puede superar 2 MiB.')
  }
  const reader = request.body?.getReader()
  if (!reader) throw new CatalogError(400, 'INVALID_IMAGE', 'Falta la fotografía.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel()
        throw new CatalogError(413, 'IMAGE_TOO_LARGE', 'La fotografía no puede superar 2 MiB.')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return prepareImage(bytes, contentType)
}

export async function productImage(request: Request, productId: string, binding: unknown,
  profile: StaffProfile, config: { url: string; key: string }, upstream: Upstream, headers: Headers): Promise<Response> {
  if (profile.role !== 'admin' && profile.role !== 'cashier') throw new CatalogError(403, 'FORBIDDEN', 'No tienes permiso para esta operación.')
  if (request.method === 'POST' && profile.role !== 'admin') throw new CatalogError(403, 'FORBIDDEN', 'No tienes permiso para esta operación.')
  const media = bucket(binding)
  const read = () => catalogRpc(request, config, upstream, 'catalog', 'media.read', { product_id: productId })
  if (request.method === 'GET') {
    const details = metadata(await read(), productId)
    if (!details) return notFound()
    let object: MediaObject | null
    try { object = await media.get(details.key) } catch { return unavailable() }
    if (!object) return notFound()
    if (object.size !== details.size || !object.body) unavailable()
    headers.set('Content-Type', details.mime)
    headers.set('Content-Length', String(object.size))
    headers.set('Content-Disposition', 'inline')
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
    return new Response(object.body, { headers })
  }
  const expectedImage = request.headers.get('X-Expected-Image-Id')
  const expectedPeriod = request.headers.get('X-Expected-Period-Id')
  if (expectedImage === null || (expectedImage && !uuid.test(expectedImage))) {
    throw new CatalogError(400, 'INVALID_INPUT', 'Actualiza el producto antes de adjuntar una fotografía.')
  }
  if (!expectedPeriod || !uuid.test(expectedPeriod)) throw new CatalogError(422, 'PERIOD_REQUIRED', 'Actualiza el período operativo antes de continuar.')
  // Compare the current association before storing, then PostgreSQL compares it
  // again atomically at attachment time. R2 and PostgreSQL share no transaction.
  const current = metadata(await read(), productId)
  if ((current?.imageId ?? '') !== expectedImage) throw new CatalogError(409, 'IMAGE_CONFLICT', 'La fotografía cambió. Actualiza el producto.')
  const image = await readImage(request)
  const imageId = crypto.randomUUID()
  const key = `products/${productId}/${imageId}`
  let stored: { etag: string; size: number } | null
  try {
    stored = await media.put(key, image.bytes.slice().buffer, {
      httpMetadata: { contentType: image.mime, cacheControl: 'private, no-store' }, onlyIf: { etagDoesNotMatch: '*' },
    })
  } catch { return unavailable() }
  if (!stored || typeof stored.etag !== 'string' || stored.size !== image.bytes.length) return unavailable()
  try {
    await catalogRpc(request, config, upstream, 'catalog', 'media.attach', {
      product_id: productId, image_id: imageId, object_key: key, mime: image.mime,
      size: image.bytes.length, width: image.width, height: image.height, etag: stored.etag,
      expected_image_id: expectedImage || null, expected_period: expectedPeriod,
    }, imageId)
  } catch (cause) {
    // An upstream timeout can occur after COMMIT. Never delete a possibly
    // referenced image. Reconcile this exact ID; unresolved objects stay private
    // for a later reference-aware cleanup, rather than risking data loss.
    try {
      if (metadata(await read(), productId)?.imageId === imageId) return Response.json({ image_id: imageId }, { headers })
    } catch { /* Keep the original normalized error, no upstream logging. */ }
    throw cause
  }
  return Response.json({ image_id: imageId }, { status: 201, headers })
}
