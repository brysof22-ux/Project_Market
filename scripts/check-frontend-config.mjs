import { loadEnv } from 'vite'

// Public build settings only. Report names, never configuration values/tokens.
const env = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env }
const invalid = []
try {
  const url = new URL(env.VITE_SUPABASE_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error()
} catch { invalid.push('VITE_SUPABASE_URL') }
if (!env.VITE_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')) invalid.push('VITE_SUPABASE_PUBLISHABLE_KEY')
if (env.VITE_API_URL !== 'https://cai-market-api.brysof22.workers.dev') invalid.push('VITE_API_URL')
if (invalid.length) {
  console.error(`Configuración de producción ausente o inválida: ${invalid.join(', ')}. No publicar dist.`)
  process.exitCode = 1
} else console.log('Variables públicas de producción válidas. No verifica credenciales ni conectividad remota.')
