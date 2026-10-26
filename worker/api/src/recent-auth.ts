// Call only after Supabase Auth has verified this exact bearer token.
// Refreshing a session (iat/token_refresh) is deliberately insufficient.
export function recentlyAuthenticated(request: Request, actorId: string, now = Date.now()): boolean {
  try {
    const token = request.headers.get('Authorization')!.slice(7)
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(encoded)) as Record<string, unknown>
    if (claims.sub !== actorId || typeof claims.session_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.session_id) || !Array.isArray(claims.amr)) return false
    const accepted = ['password', 'otp', 'totp', 'webauthn', 'oauth']
    return claims.amr.some((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false
      const { method, timestamp } = entry as Record<string, unknown>
      return typeof method === 'string' && accepted.includes(method) && typeof timestamp === 'number'
        && Number.isInteger(timestamp) && timestamp <= Math.floor(now / 1000) + 5
        && timestamp >= Math.floor(now / 1000) - 300
    })
  } catch { return false }
}
