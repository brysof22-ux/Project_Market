import { loadEnv } from 'vite'
import { invalidProductionSettings } from '../shared/production-config.ts'

// Report names only; never print configuration values or tokens.
const invalid = invalidProductionSettings({ ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env })
if (invalid.length) {
  console.error(`Configuración de producción ausente o inválida: ${invalid.join(', ')}. No publicar dist.`)
  process.exitCode = 1
} else {
  console.log('Destinos del Supabase original y API de producción válidos. La clave solo se valida por formato; no verifica conectividad ni estado SQL.')
}
