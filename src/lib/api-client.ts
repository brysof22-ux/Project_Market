import { readStaffProfile, type StaffProfile } from '../../shared/profile'
import type { CatalogAction } from '../../shared/catalog'
import type { OperationAction } from '../../shared/operations'
import { validBusinessResponse } from '../../shared/business-response'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function checkMaintenance(response: Response): Promise<void> {
  if (response.status !== 503) return

  try {
    const body: unknown = await response.clone().json()

    if (
      body &&
      typeof body === 'object' &&
      'error' in body &&
      body.error &&
      typeof body.error === 'object' &&
      'code' in body.error &&
      body.error.code === 'SERVICE_MAINTENANCE'
    ) {
      throw new ApiError(
        503,
        'SERVICE_MAINTENANCE',
        'CAI Market está en mantenimiento. Intenta nuevamente en unos minutos.',
      )
    }
  } catch (cause) {
    if (cause instanceof ApiError) throw cause
  }
}
export function createApiClient(options: {
  baseUrl: string
  getSession: () => Promise<{ access_token: string } | null>
  fetcher?: typeof fetch
}) {
  function endpoint(path: string) {
    try {
      const url = new URL(options.baseUrl)
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error()
      return new URL(path, url.origin)
    } catch { throw new ApiError(503, 'API_CONFIGURATION', 'El servicio de perfiles no está configurado. Contacta al administrador.') }
  }
  async function command<T>(section: 'catalog' | 'operations', action: CatalogAction | OperationAction, data: Record<string, unknown>, key?: string, signal?: AbortSignal): Promise<T> {
      const url = endpoint(`/api/${section}`)
      const session = await options.getSession()
      if (!session?.access_token) throw new ApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida. Inicia sesión de nuevo.')
      let response: Response
      try {
        response = await (options.fetcher ?? fetch)(url, {
          method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, data, ...(key ? { key } : {}) }),
          redirect: 'error', cache: 'no-store', credentials: 'omit',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        })
      } catch { throw new ApiError(503, 'API_UNAVAILABLE', 'No se pudo completar la operación. Reintenta con los mismos datos.') }
      await checkMaintenance(response)
      if (response.status === 401) throw new ApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida. Inicia sesión de nuevo.')
      if (response.status === 403) {
        try {
          const error: unknown = await response.json()
          if (error && typeof error === 'object' && 'error' in error && error.error && typeof error.error === 'object' && 'code' in error.error && error.error.code === 'RECENT_AUTH_REQUIRED') {
            throw new ApiError(403, 'RECENT_AUTH_REQUIRED', 'Confirma de nuevo tu identidad antes de reiniciar la operación.')
          }
        } catch (cause) { if (cause instanceof ApiError) throw cause }
        throw new ApiError(403, 'FORBIDDEN', 'No tienes permiso para esta operación.')
      }
      if (response.status === 422) {
        const messages: Record<string, string> = {
          TRANSFER_CONFIRMATION_REQUIRED: 'Verifica manualmente la recepción de la transferencia.',
          IMAGE_CONFLICT: 'El QR cambió. Actualiza el QR y verifica el pago nuevamente.',
          INVALID_PURCHASE: 'Revisa las unidades enteras y el precio total de compra.',
          WHATSAPP_NOT_READY: 'Conecta y verifica Evolution API antes de activar los avisos.',
          CONSENT_REQUIRED: 'Registra primero la autorización explícita del cliente.',
          INVALID_CONSENT: 'Verifica el número y la evidencia de autorización.',
          NOTIFICATION_NOT_RETRYABLE: 'Este mensaje requiere revisión; no se reintenta un resultado incierto.',
          NOTIFICATIONS_IN_PROGRESS: 'Espera a que finalice el envío en curso antes de eliminar la operación.',
          VERSION_CONFLICT: 'Otro usuario modificó el registro. Actualiza la vista antes de editarlo.',
          INSUFFICIENT_STOCK: 'No hay existencias suficientes para esta operación.',
          INSUFFICIENT_CASH: 'El efectivo esperado de la caja no alcanza para esta salida.',
          CREDIT_LIMIT_EXCEEDED: 'El saldo supera el cupo de crédito autorizado.',
          AMOUNT_EXCEEDS_DEBT: 'El abono no puede superar la deuda pendiente.',
          CANNOT_DISABLE_SELF: 'No puedes desactivar o cambiar tu propio rol de administrador.',
          CASH_SESSION_NOT_OPEN: 'La caja está cerrada o no está disponible. Actualiza la vista.',
          SALE_ALREADY_RETURNED: 'Esta venta ya tiene una devolución registrada.',
          PAYMENT_REFERENCE_REQUIRED: 'Registra la referencia del pago o reintegro no efectivo.',
          PERIOD_CHANGED: 'El período operativo cambió. Recarga la aplicación antes de continuar.',
          OPERATION_IN_PROGRESS: 'Hay una operación concurrente. Espera a que termine y vuelve a comprobar.',
          OPERATION_BUSY: 'Hay una operación concurrente. Espera a que termine y vuelve a comprobar.',
          OPEN_CASH_SESSIONS: 'Resuelve y cierra todas las cajas abiertas antes de reiniciar.',
          RECENT_AUTH_REQUIRED: 'Confirma de nuevo tu identidad antes de reiniciar la operación.',
          INVALID_CONFIRMATION: 'Escribe exactamente ELIMINAR OPERACION para confirmar.',
          CONFIRMATION_REQUIRED: 'Escribe exactamente ELIMINAR OPERACION para confirmar.',
          PERIOD_REQUIRED: 'No se pudo verificar el período. Recarga la aplicación antes de continuar.',
          STOCK_CONFLICT: 'Las existencias cambiaron mientras editabas. Actualiza el producto antes de repetir el conteo.',
          RESET_INTENT_EXPIRED: 'La confirmación venció. Verifica tu identidad y revisa el alcance otra vez.',
          RESET_SNAPSHOT_CHANGED: 'Los datos cambiaron. Verifica tu identidad y revisa el alcance otra vez.',
          RESET_INTENT_INVALID: 'La confirmación venció o ya no corresponde a tu sesión. Verifica tu identidad y revisa el alcance otra vez.',
          RESET_PREVIEW_CHANGED: 'Los datos cambiaron. Verifica tu identidad y revisa el alcance otra vez.',
          RESET_CONFIRMATION_REQUIRED: 'Escribe exactamente ELIMINAR OPERACION para confirmar.',
          CREDIT_IDENTITY_REQUIRED: 'Para vender a crédito, indica nombre completo y teléfono o selecciona una persona existente.',
          DEBT_NOT_FOUND: 'Esta deuda ya no está disponible en el período activo. Actualiza la vista.',
          PRICE_CHANGED: 'Los precios cambiaron durante la venta. Actualiza los productos y revisa nuevamente el carrito y sus pagos.',
        }
        let code = 'INVALID_OPERATION'
        try {
          const error = await response.json() as { error?: { code?: unknown } }
          if (typeof error.error?.code === 'string' && Object.hasOwn(messages, error.error.code)) code = error.error.code
        } catch { /* Never expose arbitrary upstream text. */ }
        throw new ApiError(422, code, messages[code] ?? 'No se guardó el cambio. Revisa datos, existencias y posibles modificaciones de otro usuario.')
      }
      if (!response.ok) throw new ApiError(503, 'API_UNAVAILABLE', 'El servicio no está disponible. Inténtalo de nuevo.')
      try {
        const result: unknown = await response.json()
        if (!validBusinessResponse(action, result)) throw new Error()
        return result as T
      }
      catch { throw new ApiError(502, 'INVALID_RESPONSE', 'La respuesta recibida no es válida.') }
  }
  async function readMediaImage(kind: 'products' | 'transfer-qr', id: string, signal?: AbortSignal, version?: string): Promise<Blob | null> {
      if (!(kind === 'products' ? /^[0-9a-f-]{36}$/i : /^(nequi|breb)$/).test(id)) throw new ApiError(400, 'INVALID_INPUT', 'Producto no válido.')
      const session = await options.getSession()
      if (!session?.access_token) throw new ApiError(401, 'UNAUTHORIZED', 'Inicia sesión de nuevo.')
      const response = await (options.fetcher ?? fetch)(endpoint(`/api/${kind}/${id}/image${version ? `?version=${encodeURIComponent(version)}` : ""}`), {
        headers: { Authorization: `Bearer ${session.access_token}` }, redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      })
      await checkMaintenance(response)
      if (response.status === 404) return null
      if (!response.ok) throw new ApiError(response.status, 'IMAGE_UNAVAILABLE', 'No se pudo cargar la fotografía.')
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(response.headers.get('Content-Type')?.split(';')[0] ?? '')) throw new ApiError(502, 'INVALID_RESPONSE', 'Fotografía no válida.')
      const blob = await response.blob()
      if (blob.size > 2 * 1024 * 1024) throw new ApiError(502, 'INVALID_RESPONSE', 'Fotografía demasiado grande.')
      return blob
    }
  async function uploadMediaImage(kind: 'products' | 'transfer-qr', id: string, blob: Blob, expectedImage: string | null, period?: string): Promise<{ image_id: string }> {
      if (!(kind === 'products' ? /^[0-9a-f-]{36}$/i : /^(nequi|breb)$/).test(id) || !['image/jpeg', 'image/png', 'image/webp'].includes(blob.type) || blob.size > 2 * 1024 * 1024) throw new ApiError(400, 'INVALID_IMAGE', 'Usa una imagen PNG, JPEG o WebP de hasta 2 MiB.')
      const session = await options.getSession()
      if (!session?.access_token) throw new ApiError(401, 'UNAUTHORIZED', 'Inicia sesión de nuevo.')
      let response: Response
      try {
        response = await (options.fetcher ?? fetch)(endpoint(`/api/${kind}/${id}/image`), {
          method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': blob.type,
            'X-Expected-Image-Id': expectedImage ?? '', 'X-Expected-Period-Id': period ?? '' }, body: blob,
          redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(30_000),
        })
      } catch { throw new ApiError(503, 'IMAGE_UNAVAILABLE', kind === 'products' ? 'El producto se guardó; no se pudo adjuntar la fotografía. Puedes reintentar.' : 'No se pudo actualizar el QR. Puedes reintentar.') }
      await checkMaintenance(response)
      if (!response.ok) throw new ApiError(response.status, 'IMAGE_UNAVAILABLE', 'No se pudo adjuntar la imagen. Actualiza la vista antes de reintentar.')
      const result: unknown = await response.json()
      if (!result || typeof result !== 'object' || !('image_id' in result) || typeof result.image_id !== 'string' || !(kind === 'products' ? /^[0-9a-f-]{36}$/i : /^[a-f0-9]{64}$/).test(result.image_id)) throw new ApiError(502, 'INVALID_RESPONSE', 'No se pudo verificar la fotografía guardada.')
      return { image_id: result.image_id }
    }
  return {
    productImage: (id: string, signal?: AbortSignal) => readMediaImage('products', id, signal),
    transferQRImage: (code: string, signal?: AbortSignal, version?: string) => readMediaImage('transfer-qr', code, signal, version),
    uploadProductImage: (id: string, blob: Blob, expectedImage: string | null, period: string) => uploadMediaImage('products', id, blob, expectedImage, period),
    uploadTransferQRImage: (code: string, blob: Blob, expectedImage: string | null) => uploadMediaImage('transfer-qr', code, blob, expectedImage),
    catalog: <T>(action: CatalogAction, data: Record<string, unknown>, key?: string, signal?: AbortSignal) => command<T>('catalog', action, data, key, signal),
    operations: <T>(action: OperationAction, data: Record<string, unknown>, key?: string, signal?: AbortSignal) => command<T>('operations', action, data, key, signal),
    async getMe(signal?: AbortSignal): Promise<StaffProfile> {
      const url = endpoint('/api/me')
      const session = await options.getSession()
      if (!session?.access_token) throw new ApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida. Inicia sesión de nuevo.')
      let response: Response
      try {
        response = await (options.fetcher ?? fetch)(url, {
          method: 'GET', headers: { Authorization: `Bearer ${session.access_token}` },
          redirect: 'error', cache: 'no-store', credentials: 'omit',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        })
      } catch { throw new ApiError(503, 'API_UNAVAILABLE', 'No pudimos consultar tu perfil. Comprueba la conexión y vuelve a intentarlo.') }
      await checkMaintenance(response)
      if (response.status === 401) throw new ApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida. Inicia sesión de nuevo.')
      if (response.status === 403) throw new ApiError(403, 'PROFILE_FORBIDDEN', 'No tienes un perfil activo. Contacta al administrador.')
      if (!response.ok) throw new ApiError(503, 'API_UNAVAILABLE', 'El servicio de perfiles no está disponible. Inténtalo de nuevo.')
      let body: unknown
      try { body = await response.json() } catch { throw new ApiError(502, 'INVALID_RESPONSE', 'No pudimos validar el perfil recibido.') }
      const profile = readStaffProfile(body)
      if (!profile) throw new ApiError(502, 'INVALID_RESPONSE', 'No pudimos validar el perfil recibido.')
      if (!profile.active) throw new ApiError(403, 'PROFILE_FORBIDDEN', 'No tienes un perfil activo. Contacta al administrador.')
      return profile
    },
  }
}
