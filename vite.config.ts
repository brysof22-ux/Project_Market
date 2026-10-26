import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { invalidProductionSettings, productionTargets } from './shared/production-config.ts'

// Production is published from main. Keep the release-branch publication block:
// it does not affect main, and no Preview environment is authorized.
if (['release/cai-market-v1', 'feature/cai-market-v1.1'].includes(process.env.CF_PAGES_BRANCH ?? '')) {
  throw new Error('PREVIEW_BLOCKED: CAI Market V1 requires a verified isolated Supabase and API before publication.')
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    const development = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }
    // A developer may already have V1 production URLs in .env.local. Starting
    // V1.1 locally must not silently reuse those live commercial endpoints.
    if (development.VITE_SUPABASE_URL?.trim() === productionTargets.supabase
      || development.VITE_API_URL?.trim() === productionTargets.api) {
      throw new Error('DEVELOPMENT_PRODUCTION_BLOCKED: configure an isolated backend before developing V1.1.')
    }
  }
  if (command === 'build' && mode === 'production') {
    const invalid = invalidProductionSettings({ ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env })
    if (invalid.length) throw new Error(`PRODUCTION_CONFIGURATION: ${invalid.join(', ')}`)
  }
  return {
    server: { watch: { ignored: ['**/.cache/**'] } },
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  }
})
