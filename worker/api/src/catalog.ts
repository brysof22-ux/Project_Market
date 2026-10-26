import { catalogActions } from '../../../shared/catalog'
import { operationActions } from '../../../shared/operations'
import { canPerform } from '../../../shared/permissions'
import type { StaffProfile } from '../../../shared/profile'
import { recentlyAuthenticated } from './recent-auth'

export class CatalogError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export async function catalogRequest(request: Request, config: { url: string; key: string },
  upstream: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, section: 'catalog' | 'operations', profile: StaffProfile) {
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
  if (!canPerform(profile.role, section, body.action)) throw new CatalogError(403, 'FORBIDDEN', 'No tienes permiso para esta operación.')
  if (body.action === 'reset.confirm' && !recentlyAuthenticated(request, profile.id)) {
    throw new CatalogError(403, 'RECENT_AUTH_REQUIRED', 'Vuelve a autenticarte antes de reiniciar la operación.')
  }
  return catalogRpc(request, config, upstream, section, body.action, body.data as Record<string, unknown>, typeof body.key === 'string' ? body.key : null)
}

export async function catalogRpc(request: Request, config: { url: string; key: string },
  upstream: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, section: 'catalog' | 'operations',
  action: string, data: Record<string, unknown>, key: string | null = null) {
  let response: Response
  try {
    const rpc = section === 'catalog' ? 'cai_catalog' : action === 'report' ? 'cai_report' : 'cai_operations'
    response = await upstream(`${config.url}/rest/v1/rpc/${rpc}`, {
      method: 'POST', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: request.headers.get('Authorization')!, apikey: config.key,
        'Content-Type': 'application/json', 'Content-Profile': 'public', 'Accept-Profile': 'public' },
      body: JSON.stringify(action === 'report' ? { p_data: data } : { p_action: action, p_data: data, p_key: key }),
    })
  } catch { throw new CatalogError(503, 'CATALOG_UNAVAILABLE', 'No se pudo consultar el catálogo.') }
  if (response.status === 401) throw new CatalogError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.')
  if (response.status === 403) throw new CatalogError(403, 'FORBIDDEN', 'No tienes permiso para esta operación.')
  if (response.status === 400 || response.status === 409 || response.status === 422 || response.status === 423 || response.status === 500) {
    let code = 'INVALID_OPERATION'
    try {
      const error = await response.json() as { message?: unknown; code?: unknown }
      // PostgREST maps SQLSTATE 55P03 (NOWAIT row contention) to HTTP 500.
      // Preserve only this exact application code; unrelated 500 bodies stay private.
      if (response.status === 500) {
        if (error.code === '55P03' && error.message === 'OPERATION_IN_PROGRESS') code = 'OPERATION_IN_PROGRESS'
      } else {
      if (typeof error.message === 'string' && ['VERSION_CONFLICT', 'PRICE_CHANGED', 'INSUFFICIENT_STOCK',
        'PRODUCT_NOT_AVAILABLE', 'SUPPLIER_NOT_ACTIVE', 'IDEMPOTENCY_CONFLICT', 'CASH_SESSION_NOT_OPEN',
        'INSUFFICIENT_CASH', 'CREDIT_LIMIT_EXCEEDED', 'AMOUNT_EXCEEDS_DEBT', 'SALE_ALREADY_RETURNED',
        'CANNOT_DISABLE_SELF', 'PAYMENTS_DO_NOT_MATCH', 'PAYMENT_REFERENCE_REQUIRED',
        'PERIOD_REQUIRED', 'PERIOD_CHANGED', 'OPERATION_BUSY', 'OPERATION_IN_PROGRESS', 'OPEN_CASH_SESSIONS',
        'RECENT_AUTH_REQUIRED', 'CONFIRMATION_REQUIRED', 'IMAGE_CONFLICT', 'STOCK_CONFLICT',
        'CUSTOMER_REQUIRED', 'PHONE_REQUIRED', 'INVALID_DUE_DATE', 'CREDIT_IDENTITY_REQUIRED', 'DEBT_NOT_FOUND',
        'TRANSFER_CONFIRMATION_REQUIRED', 'RESET_INTENT_INVALID', 'RESET_PREVIEW_CHANGED', 'RESET_CONFIRMATION_REQUIRED'].includes(error.message)) code = error.message
      }
    } catch { /* Do not expose upstream error bodies. */ }
    if (response.status === 500 && code !== 'OPERATION_IN_PROGRESS') throw new CatalogError(503, 'CATALOG_UNAVAILABLE', 'El catálogo no está disponible.')
    throw new CatalogError(422, code, 'No se guardó la operación. Revisa los datos y actualiza la vista.')
  }
  if (!response.ok) throw new CatalogError(503, 'CATALOG_UNAVAILABLE', 'El catálogo no está disponible.')
  try { return await response.json() as unknown }
  catch { throw new CatalogError(502, 'INVALID_UPSTREAM_RESPONSE', 'Respuesta del catálogo no válida.') }
}
