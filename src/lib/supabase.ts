import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const AUTH_STORAGE_KEY = 'cai-market:auth:v1'
let client: SupabaseClient | undefined

export function getSupabaseClient() {
  if (client) return client
  const url = import.meta.env.VITE_SUPABASE_URL?.trim()
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  if (!url || !key) throw new Error('Faltan VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY. Revisa .env.local y reinicia Vite.')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('VITE_SUPABASE_URL no es una URL válida.') }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('La conexión a Supabase debe utilizar HTTPS.')
  }
  // VITE_* is shipped to the browser. Never accept secret/service-role keys.
  if (!key.startsWith('sb_publishable_')) {
    throw new Error('Usa una clave pública Supabase Publishable (sb_publishable_). Las claves privadas no pertenecen al frontend.')
  }
  client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: AUTH_STORAGE_KEY },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      }),
    },
  })
  return client
}
