import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AuthApiError, type Session } from '@supabase/supabase-js'
import { AUTH_STORAGE_KEY, getSupabaseClient } from '../../lib/supabase'
import { AuthContext } from './context'

function authMessage(cause: unknown) {
  if (cause instanceof AuthApiError) {
    if (cause.code === 'invalid_credentials') return 'Correo o contraseña incorrectos.'
    if (cause.code === 'email_not_confirmed') return 'Confirma tu correo antes de iniciar sesión.'
    if (cause.status === 429) return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.'
  }
  return 'No pudimos conectar con el servicio de acceso. Comprueba tu conexión e inténtalo de nuevo.'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [connection] = useState(() => {
    try { return { client: getSupabaseClient(), error: '' } }
    catch (cause) { return { client: null, error: cause instanceof Error ? cause.message : 'Revisa la configuración de Supabase.' } }
  })
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(!!connection.client)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const revision = useRef(0)
  const signingOut = useRef(false)
  const verification = useRef<Promise<void>>(Promise.resolve())
  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    const client = connection.client
    if (!client) return
    let active = true
    let eventReceived = false
    async function accept(candidate: Session | null) {
      const version = ++revision.current
      if (!candidate) {
        if (active) { setSession(null); if (!signingOut.current) setLoading(false) }
        return
      }
      if (signingOut.current) return
      try {
        // A persisted session is browser input. Verify its user with Auth before
        // rendering private content; never query the private pos schema here.
        const { data, error: verificationError } = await client!.auth.getUser(candidate.access_token)
        if (!active || version !== revision.current || signingOut.current) return
        if (verificationError || !data.user || data.user.id !== candidate.user.id || !candidate.expires_at || candidate.expires_at * 1000 <= Date.now()) {
          setSession(null)
          setError('Tu sesión ya no es válida. Inicia sesión de nuevo.')
        } else {
          setSession({ ...candidate, user: data.user })
          setError('')
        }
      } catch {
        if (!active || version !== revision.current) return
        setSession(null)
        setError('No pudimos verificar tu sesión. Comprueba tu conexión y vuelve a intentarlo.')
      } finally {
        if (active && version === revision.current) setLoading(false)
      }
    }
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => {
      eventReceived = true
      // Do not await Auth calls inside its event callback.
      verification.current = accept(next)
    })
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active || eventReceived) return
      if (sessionError) { setError(authMessage(sessionError)); setLoading(false) }
      else void accept(data.session)
    }).catch(() => {
      if (active && !eventReceived) { setLoading(false); setError('No pudimos recuperar tu sesión. Vuelve a intentarlo.') }
    })
    return () => { active = false; subscription.unsubscribe() }
  }, [connection, attempt])

  useEffect(() => {
    if (!session?.expires_at) return
    const expires = session.expires_at * 1000
    const checkExpiry = () => {
      if (Date.now() < expires) return
      revision.current++
      setSession(null)
      setError('Tu sesión venció. Inicia sesión de nuevo.')
      // SDK normally refreshes before this point. Hide private UI immediately
      // if offline or refresh failed, then allow a successful refresh to restore it.
      void connection.client?.auth.refreshSession().catch(() => {})
    }
    const timer = window.setTimeout(checkExpiry, Math.max(0, expires - Date.now()))
    window.addEventListener('focus', checkExpiry)
    return () => { clearTimeout(timer); window.removeEventListener('focus', checkExpiry) }
  }, [session, connection])

  async function signIn(email: string, password: string) {
    if (!connection.client || signingOut.current) return
    setError('')
    try {
      const { error: signInError } = await connection.client.auth.signInWithPassword({ email: email.trim(), password })
      if (signInError) setError(authMessage(signInError))
      else await verification.current
    } catch (cause) { setError(authMessage(cause)) }
  }
  async function signOut() {
    if (!connection.client || signingOut.current) return
    signingOut.current = true
    setLoading(true)
    revision.current++
    setSession(null)
    setError('')
    try {
      const { error: signOutError } = await connection.client.auth.signOut({ scope: 'local' })
      if (signOutError) setError('Acceso local cerrado. No pudimos confirmar el cierre en el servidor.')
    } catch { setError('Acceso local cerrado. No pudimos confirmar el cierre en el servidor.') }
    finally {
      try { localStorage.removeItem(AUTH_STORAGE_KEY) } catch { /* SDK also attempts to clear its storage. */ }
      signingOut.current = false
      setLoading(false)
    }
  }
  return <AuthContext.Provider value={{ session, loading, error, configurationError: connection.error, signIn, signOut, retry }}>{children}</AuthContext.Provider>
}
