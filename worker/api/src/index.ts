import {runWhatsApp,type WhatsAppEnv} from './whatsapp'
import { readStaffProfile } from '../../../shared/profile'
import { catalogRequest, CatalogError } from './catalog'
import { productImage, transferImage } from './media'

export interface Env extends WhatsAppEnv {
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  ALLOWED_ORIGIN: string
  // Development-only fence. When present it must be "true"; false/empty is an
  // invalid configuration, never an escape hatch to a remote database.
  LOCAL_ONLY?: string
  // Validated structurally at the storage boundary; absent bindings fail closed.
  MEDIA: unknown
}
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function configuration(env: Env) {
  try {
    const url = new URL(env.SUPABASE_URL)
    const localOnly = env.LOCAL_ONLY !== undefined
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((localOnly && (env.LOCAL_ONLY !== 'true' || (!loopback && !url.hostname.endsWith('.invalid'))))
      || (url.protocol !== 'https:' && !(localOnly && loopback && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !env.SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')) throw new Error()
    return { url: url.origin, key: env.SUPABASE_PUBLISHABLE_KEY }
  } catch { throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Servicio temporalmente no disponible.') }
}

async function readJson(response: Response) {
  try { return await response.json() as unknown }
  catch { throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'Respuesta del servicio no válida.') }
}

type AuthException = 'TypeError' | 'TimeoutError' | 'AbortError' | 'SyntaxError' | 'Error' | 'UnknownError'

function authException(cause: unknown): AuthException {
  // Never serialize the exception or copy arbitrary names/messages into logs.
  try {
    const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : null
    switch (name) {
      case 'TypeError': case 'TimeoutError': case 'AbortError': case 'SyntaxError': case 'Error': return name
      default: return 'UnknownError'
    }
  } catch { return 'UnknownError' }
}

// TEMPORARY: remove after diagnosing AUTH_UNAVAILABLE. Explicit allowlist only.
function logAuthDiagnostic(phase: 'auth_fetch' | 'auth_body', started: number,
  status: number | null, signal: AbortSignal | undefined, exception: AuthException | null = null) {
  try {
    console.log(JSON.stringify({
      event: 'auth_diagnostic', phase,
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
      upstream_status: status, exception_type: exception,
      timeout: signal?.aborted === true || exception === 'TimeoutError',
    }))
  } catch { /* Diagnostics must never alter authentication or public responses. */ }
}

async function currentProfile(request: Request, env: Env, upstream: Fetcher) {
  const authorization = request.headers.get('Authorization') ?? ''
  // Only syntax is checked locally. Auth verifies signature, expiry and subject.
  if (authorization.length > 16_384 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Se requiere una sesión válida.')
  }
  const { url, key } = configuration(env)
  const headers = { Authorization: authorization, apikey: key }
  let verified: Response
  let authSignal: AbortSignal | undefined
  const fetchStarted = performance.now()
  try {
    authSignal = AbortSignal.timeout(10_000)
    // workerd rejects redirect:error before network I/O. Manual never follows
    // Location; all 3xx remain rejected by the !ok check below.
    verified = await upstream(`${url}/auth/v1/user`, { headers, redirect: 'manual', signal: authSignal })
  } catch (cause) {
    logAuthDiagnostic('auth_fetch', fetchStarted, null, authSignal, authException(cause))
    throw new HttpError(503, 'AUTH_UNAVAILABLE', 'No se pudo verificar la sesión.')
  }
  logAuthDiagnostic('auth_fetch', fetchStarted, verified.status, authSignal)
  if (verified.status === 401 || verified.status === 403 || verified.status === 400) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Se requiere una sesión válida.')
  }
  if (!verified.ok) throw new HttpError(503, 'AUTH_UNAVAILABLE', 'No se pudo verificar la sesión.')
  let user: unknown
  const bodyStarted = performance.now()
  try { user = await verified.json() as unknown }
  catch (cause) {
    logAuthDiagnostic('auth_body', bodyStarted, verified.status, authSignal, authException(cause))
    throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'Respuesta del servicio no válida.')
  }
  logAuthDiagnostic('auth_body', bodyStarted, verified.status, authSignal)
  if (!user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string') {
    throw new HttpError(401, 'UNAUTHORIZED', 'Se requiere una sesión válida.')
  }
  let result: Response
  try {
    result = await upstream(`${url}/rest/v1/rpc/cai_current_profile`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Profile': 'public', 'Accept-Profile': 'public' },
      body: '{}', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    })
  } catch { throw new HttpError(503, 'PROFILE_UNAVAILABLE', 'No se pudo consultar el perfil.') }
  if (result.status === 401) throw new HttpError(401, 'UNAUTHORIZED', 'Se requiere una sesión válida.')
  // A 403 from RPC is a permission/configuration failure, not proof of no profile.
  // Missing or inactive profiles are an empty successful result from the RPC.
  if (!result.ok) throw new HttpError(503, 'PROFILE_UNAVAILABLE', 'No se pudo consultar el perfil.')
  const rows = await readJson(result)
  if (!Array.isArray(rows) || rows.length > 1) throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'Respuesta del servicio no válida.')
  if (!rows.length) throw new HttpError(403, 'PROFILE_FORBIDDEN', 'No tienes un perfil activo. Contacta al administrador.')
  const profile = readStaffProfile(rows[0])
  if (!profile || profile.id !== user.id) throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'Respuesta del servicio no válida.')
  if (!profile.active) throw new HttpError(403, 'PROFILE_FORBIDDEN', 'No tienes un perfil activo. Contacta al administrador.')
  return profile
}

export function createWorker(upstream: Fetcher = fetch) {
  return {
    async scheduled(_event:unknown,env:Env,context:{waitUntil:(task:Promise<unknown>)=>void}) { context.waitUntil(runWhatsApp(env,configuration(env),upstream)) },
    async fetch(request: Request, env: Env): Promise<Response> {
      const origin = request.headers.get('Origin')
      const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' })
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
      try {
        // No wildcard, suffix matching or origin reflection. CLI without Origin
        // is permitted and still requires authentication on /api/me.
        if (!env.ALLOWED_ORIGIN || new URL(env.ALLOWED_ORIGIN).origin !== env.ALLOWED_ORIGIN) {
          throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Servicio temporalmente no disponible.')
        }
        if (origin !== null && origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'Origen no autorizado.')
        if (origin !== null) headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN)
        const path = new URL(request.url).pathname
        const businessRoute = path === '/api/catalog' || path === '/api/operations'
        const qrRoute = /^\/api\/transfer-qr\/(nequi|breb)\/image$/.exec(path)
        const imageRoute = /^\/api\/products\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/image$/i.exec(path)
        if (path !== '/api/me' && path !== '/health' && !businessRoute && !imageRoute && !qrRoute) throw new HttpError(404, 'NOT_FOUND', 'Ruta no encontrada.')
        const expectedMethod = businessRoute ? 'POST' : 'GET'
        const methods = (imageRoute || qrRoute) ? ['GET', 'POST'] : [expectedMethod]
        if (request.method === 'OPTIONS') {
          if (!origin || !methods.includes(request.headers.get('Access-Control-Request-Method') ?? '')) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.')
          const requested = (request.headers.get('Access-Control-Request-Headers') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
          const allowedHeaders = (imageRoute || qrRoute) ? ['authorization', 'accept', 'content-type', 'x-expected-image-id', 'x-expected-period-id']
            : businessRoute ? ['authorization', 'accept', 'content-type'] : ['authorization', 'accept']
          if (requested.some((header) => !allowedHeaders.includes(header))) throw new HttpError(403, 'HEADERS_FORBIDDEN', 'Cabeceras no autorizadas.')
          headers.set('Access-Control-Allow-Methods', `${methods.join(', ')}, OPTIONS`)
          headers.set('Access-Control-Allow-Headers', (imageRoute || qrRoute) ? 'Authorization, Accept, Content-Type, X-Expected-Image-Id, X-Expected-Period-Id'
            : businessRoute ? 'Authorization, Accept, Content-Type' : 'Authorization, Accept')
          headers.set('Access-Control-Max-Age', '600')
          headers.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers')
          return new Response(null, { status: 204, headers })
        }
        if (!methods.includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.')
        if (path === '/health') return json({ status: 'ok' })
        if (qrRoute) {
          const profile = await currentProfile(request, env, upstream)
          return await transferImage(request, qrRoute[1], env.MEDIA, profile, configuration(env), upstream, headers)
        }
        if (imageRoute) {
          const profile = await currentProfile(request, env, upstream)
          return await productImage(request, imageRoute[1].toLowerCase(), env.MEDIA, profile, configuration(env), upstream, headers)
        }
        if (businessRoute) {
          const profile = await currentProfile(request, env, upstream)
          return json(await catalogRequest(request, configuration(env), upstream, path === '/api/catalog' ? 'catalog' : 'operations', profile, env))
        }
        return json(await currentProfile(request, env, upstream))
      } catch (cause) {
        const error = cause instanceof HttpError || cause instanceof CatalogError ? cause : new HttpError(503, 'SERVICE_UNAVAILABLE', 'Servicio temporalmente no disponible.')
        if (error.status === 405) {
          const path = new URL(request.url).pathname
          headers.set('Allow', /^\/api\/(?:products\/[0-9a-f-]{36}|transfer-qr\/(?:nequi|breb))\/image$/i.test(path) ? 'GET, POST, OPTIONS'
            : ['/api/catalog','/api/operations'].includes(path) ? 'POST, OPTIONS' : 'GET, OPTIONS')
        }
        if (error.status === 401) headers.set('WWW-Authenticate', 'Bearer')
        // Never return/log upstream bodies, tokens, stack traces or credentials.
        return json({ error: { code: error.code, message: error.message } }, error.status)
      }
    },
  }
}

export default createWorker()
