// Isolated diagnostic harness. Never imported by CAI Market's API.
export interface DiagnosticEnv {
  DIAGNOSTIC_ACCESS_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_PUBLISHABLE_KEY?: string
}
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const probes = ['construct-manual', 'construct-error', 'construct-timeout', 'baseline', 'headers-object',
  'headers-instance', 'timeout-signal', 'redirect-error'] as const
type Probe = typeof probes[number]
type Phase = 'config' | 'signal' | 'headers' | 'request' | 'fetch'
const fakeAuthorization = 'Bearer aaa.bbb.ccc'
const budget = 10_000

function exceptionType(cause: unknown) {
  try {
    const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : null
    switch (name) {
      case 'TypeError': case 'Error': case 'TimeoutError': case 'AbortError': return name
      default: return 'UnknownError'
    }
  } catch { return 'UnknownError' }
}

function configuration(env: DiagnosticEnv) {
  // Never repair/trim a credential or send it to a caller-selected destination.
  const parsed = new URL(env.SUPABASE_URL ?? '')
  if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname)
    || parsed.port || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash) throw new TypeError()
  return `${parsed.origin}/auth/v1/user`
}

export function createDiagnosticWorker(upstream: Fetcher = fetch) {
  return {
    async fetch(request: Request, env: DiagnosticEnv): Promise<Response> {
      const json = (value: unknown, status = 200) => Response.json(value, {
        status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      })
      // Disabled without a separate operator key; no browser access or CORS.
      // Never read or forward inbound Authorization, request bodies or URLs as targets.
      if (!env.DIAGNOSTIC_ACCESS_KEY || env.DIAGNOSTIC_ACCESS_KEY.length < 32
        || env.DIAGNOSTIC_ACCESS_KEY.startsWith('REPLACE_')
        || request.headers.get('X-Diagnostic-Key') !== env.DIAGNOSTIC_ACCESS_KEY
        || request.headers.has('Origin')) return json({ error: 'FORBIDDEN' }, 403)
      if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)
      const incoming = new URL(request.url)
      const probe = incoming.pathname.slice('/probe/'.length) as Probe
      if (!incoming.pathname.startsWith('/probe/') || incoming.search || !probes.includes(probe)) {
        return json({ error: 'UNKNOWN_PROBE' }, 404)
      }

      let phase: Phase = 'config'
      let signal: AbortSignal | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const started = performance.now()
      const report = (status: number | null, cause?: unknown, failed = false) => {
        const type = failed ? exceptionType(cause) : null
        const result = {
          event: 'isolated_auth_probe', probe, phase,
          duration_ms: Math.max(0, Math.round(performance.now() - started)),
          upstream_status: status, exception_type: type,
          timeout: signal?.aborted === true || type === 'TimeoutError',
        }
        try { console.log(JSON.stringify(result)) } catch { /* Best effort only. */ }
        // 200 means the probe ran; inspect phase/status/exception, not this HTTP code.
        return json(result)
      }
      try {
        // Construction-only probes require neither a Supabase URL nor any key.
        if (probe === 'construct-manual' || probe === 'construct-error' || probe === 'construct-timeout') {
          if (probe === 'construct-timeout') {
            phase = 'signal'
            signal = AbortSignal.timeout(budget)
          }
          phase = 'request'
          new Request('https://example.invalid/auth/v1/user', {
            redirect: probe === 'construct-error' ? 'error' : 'manual',
            ...(signal ? { signal } : {}),
          })
          return report(null)
        }
        const target = configuration(env)
        phase = 'signal'
        if (probe === 'timeout-signal' || probe === 'redirect-error') {
          signal = AbortSignal.timeout(budget)
        } else {
          // A bounded control case without AbortSignal.timeout(). No unbounded fetch.
          const controller = new AbortController()
          signal = controller.signal
          timer = setTimeout(() => controller.abort(), budget)
        }
        phase = 'headers'
        let headers: HeadersInit = {}
        if (probe !== 'baseline') {
          const key = env.SUPABASE_PUBLISHABLE_KEY
          if (!key?.startsWith('sb_publishable_')) throw new TypeError()
          const values = { apikey: key, Authorization: fakeAuthorization }
          const validated = new Headers(values)
          headers = probe === 'headers-instance' ? validated : values
        }
        const init: RequestInit = {
          method: 'GET', headers, signal,
          redirect: probe === 'redirect-error' ? 'error' : 'manual',
        }
        phase = 'request'
        new Request(target, init) // Isolate constructor failures from transport errors.
        phase = 'fetch'
        const response = await upstream(target, init)
        // Never read, print, proxy or follow response bodies/Location headers.
        if (response.body) await response.body.cancel().catch(() => undefined)
        return report(response.status)
      } catch (cause) {
        return report(null, cause, true)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}

export default createDiagnosticWorker()
