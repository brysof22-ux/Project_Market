import { catalogActions } from '../../../shared/catalog'
import { operationActions } from '../../../shared/operations'

export class CatalogError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export async function catalogRequest(request: Request, config: { url: string; key: string },
  upstream: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, section: 'catalog' | 'operations' = 'catalog') {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new CatalogError(415, 'JSON_REQUIRED', 'Envía la operación en formato JSON.')
  }
  // Bound the actual stream, not just the untrusted Content-Length header.
  const reader = request.body?.getReader()
  if (!reader) throw new CatalogError(400, 'INVALID_INPUT', 'Falta la operación.')
  let bytes = 0
  let content = ''
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 32_768) {
        await reader.cancel()
        throw new CatalogError(413, 'REQUEST_TOO_LARGE', 'La operación supera el tamaño permitido.')
      }
      content += decoder.decode(chunk.value, { stream: true })
    }
    content += decoder.decode()
  } finally { reader.releaseLock() }
  let body: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    body = value as Record<string, unknown>
  } catch { throw new CatalogError(400, 'INVALID_INPUT', 'La operación no es válida.') }
  const actions: readonly string[] = section === 'catalog' ? catalogActions : operationActions
  if (typeof body.action !== 'string' || !actions.includes(body.action)
    || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)
    || (body.key !== undefined && (typeof body.key !== 'string' || body.key.length > 128))) {
    throw new CatalogError(400, 'INVALID_INPUT', 'La operación no es válida.')
  }
  let response: Response
  try {
    const rpc = section === 'catalog' ? 'cai_catalog' : body.action === 'report' ? 'cai_report' : 'cai_operations'
    response = await upstream(`${config.url}/rest/v1/rpc/${rpc}`, {
      method: 'POST', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: request.headers.get('Authorization')!, apikey: config.key,
        'Content-Type': 'application/json', 'Content-Profile': 'public', 'Accept-Profile': 'public' },
      body: JSON.stringify(body.action === 'report' ? { p_data: body.data } : { p_action: body.action, p_data: body.data, p_key: body.key ?? null }),
    })
  } catch { throw new CatalogError(503, 'CATALOG_UNAVAILABLE', 'No se pudo consultar el catálogo.') }
  if (response.status === 401) throw new CatalogError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.')
  if (response.status === 403) throw new CatalogError(403, 'FORBIDDEN', 'No tienes permiso para esta operación.')
  if (response.status === 400 || response.status === 409) {
    let code = 'INVALID_OPERATION'
    try {
      const error = await response.json() as { message?: unknown }
      if (typeof error.message === 'string' && ['VERSION_CONFLICT', 'INSUFFICIENT_STOCK',
        'PRODUCT_NOT_AVAILABLE', 'SUPPLIER_NOT_ACTIVE', 'IDEMPOTENCY_CONFLICT', 'CASH_SESSION_NOT_OPEN',
        'INSUFFICIENT_CASH', 'CREDIT_LIMIT_EXCEEDED', 'AMOUNT_EXCEEDS_DEBT', 'SALE_ALREADY_RETURNED',
        'CANNOT_DISABLE_SELF', 'PAYMENTS_DO_NOT_MATCH', 'PAYMENT_REFERENCE_REQUIRED'].includes(error.message)) code = error.message
    } catch { /* Do not expose upstream error bodies. */ }
    throw new CatalogError(422, code, 'No se guardó la operación. Revisa los datos y actualiza la vista.')
  }
  if (!response.ok) throw new CatalogError(503, 'CATALOG_UNAVAILABLE', 'El catálogo no está disponible.')
  try { return await response.json() as unknown }
  catch { throw new CatalogError(502, 'INVALID_UPSTREAM_RESPONSE', 'Respuesta del catálogo no válida.') }
}
