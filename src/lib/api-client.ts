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
      if (response.status === 401) throw new ApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida. Inicia sesión de nuevo.')
      if (response.status === 403) throw new ApiError(403, 'FORBIDDEN', 'No tienes permiso para esta operación.')
      if (response.status === 422) {
        const messages: Record<string, string> = {
          VERSION_CONFLICT: 'Otro usuario modificó el registro. Actualiza la vista antes de editarlo.',
          INSUFFICIENT_STOCK: 'No hay existencias suficientes para esta operación.',
          INSUFFICIENT_CASH: 'El efectivo esperado de la caja no alcanza para esta salida.',
          CREDIT_LIMIT_EXCEEDED: 'El saldo supera el cupo de crédito autorizado.',
          AMOUNT_EXCEEDS_DEBT: 'El abono no puede superar la deuda pendiente.',
          CANNOT_DISABLE_SELF: 'No puedes desactivar o cambiar tu propio rol de administrador.',
          CASH_SESSION_NOT_OPEN: 'La caja está cerrada o no está disponible. Actualiza la vista.',
          SALE_ALREADY_RETURNED: 'Esta venta ya tiene una devolución registrada.',
          PAYMENT_REFERENCE_REQUIRED: 'Registra la referencia del pago o reintegro no efectivo.',
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
  return {
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
