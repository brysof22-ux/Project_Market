import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { invalidProductionSettings } from './shared/production-config.ts'

// Production is published from main. Keep the release-branch publication block:
// it does not affect main, and no Preview environment is authorized.
if (process.env.CF_PAGES_BRANCH === 'release/cai-market-v1') {
  throw new Error('PREVIEW_BLOCKED: CAI Market V1 requires a verified isolated Supabase and API before publication.')
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'production') {
    const invalid = invalidProductionSettings({ ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env })
    if (invalid.length) throw new Error(`PRODUCTION_CONFIGURATION: ${invalid.join(', ')}`)
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  }
})
