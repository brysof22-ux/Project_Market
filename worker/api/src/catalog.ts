import { catalogActions } from '../../../shared/catalog'
import { operationActions } from '../../../shared/operations'
import { canPerform } from '../../../shared/permissions'
import type { StaffProfile } from '../../../shared/profile'
import {refreshEvolutionHealth,type WhatsAppEnv} from './whatsapp'
import { recentlyAuthenticated } from './recent-auth'

export class CatalogError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export async function catalogRequest(request: Request, config: { url: string; key: string },
  upstream: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, section: 'catalog' | 'operations', profile: StaffProfile, integration?:WhatsAppEnv) {
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
  if(integration && (body.action==='whatsapp.status' || (body.action==='whatsapp.settings' && (body.data as Record<string,unknown>).enabled===true))) {
    const state=await refreshEvolutionHealth(integration,config,upstream)
    if(body.action==='whatsapp.settings'&&state!=='open')throw new CatalogError(422,'WHATSAPP_NOT_READY','Conecta Evolution API antes de activar notificaciones.')
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
  } catch {
    if (action === 'reset.confirm') throw new CatalogError(503, 'RESET_RESULT_UNKNOWN', 'No se pudo confirmar el resultado del reinicio. Reintenta únicamente la misma solicitud.');
    throw new CatalogError(503, 'CATALOG_UNAVAILABLE', 'No se pudo consultar el catálogo.')
  }
  if (response.status === 401) throw new CatalogError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.')
  if (response.status === 403) {
    if (action === 'reset.confirm') {
      const value = await response.clone().json().catch(() => null) as {message?:unknown}|null;
      if (value?.message === 'RECENT_AUTH_REQUIRED') throw new CatalogError(403, 'RECENT_AUTH_REQUIRED', 'Confirma de nuevo tu identidad antes de reiniciar.');
    }
    throw new CatalogError(403, 'FORBIDDEN', 'No tienes permiso para esta operación.')
  }
  if (response.status === 400 || response.status === 409 || response.status === 422 || response.status === 423 || response.status === 500) {
    let code = 'INVALID_OPERATION'
    let sqlstate: string | null = null
    try {
      const error = await response.json() as { message?: unknown; code?: unknown }
      if (typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)) sqlstate = error.code
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
        'TRANSFER_CONFIRMATION_REQUIRED', 'INVALID_PURCHASE', 'WHATSAPP_NOT_READY', 'CONSENT_REQUIRED', 'INVALID_CONSENT', 'NOTIFICATION_NOT_RETRYABLE', 'NOTIFICATIONS_IN_PROGRESS', 'RESET_INTENT_INVALID', 'RESET_INTENT_EXPIRED', 'RESET_PREVIEW_CHANGED', 'RESET_CONFIRMATION_REQUIRED'].includes(error.message)) code = error.message
      }
    } catch { /* Do not expose upstream error bodies. */ }
    if (action === 'reset.confirm') {
      // Log codes only: never request data, identity, SQL, tokens or upstream text.
      console.warn(JSON.stringify({event:'reset_rpc_failure',upstream_status:response.status,sqlstate,code:code==='INVALID_OPERATION'?'RESET_INTERNAL_ERROR':code}))
      if (code === 'INVALID_OPERATION') throw new CatalogError(500, 'RESET_INTERNAL_ERROR', 'El servidor rechazó el reinicio por un error interno.');
    }
    if (response.status === 500 && code !== 'OPERATION_IN_PROGRESS') throw new CatalogError(503, 'CATALOG_UNAVAILABLE', 'El catálogo no está disponible.')
    throw new CatalogError(422, code, 'No se guardó la operación. Revisa los datos y actualiza la vista.')
  }
  if (!response.ok) throw new CatalogError(503, 'CATALOG_UNAVAILABLE', 'El catálogo no está disponible.')
  try { return await response.json() as unknown }
  catch { throw new CatalogError(502, 'INVALID_UPSTREAM_RESPONSE', 'Respuesta del catálogo no válida.') }
}
