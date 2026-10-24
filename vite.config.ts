import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// This release has no verified isolated backend yet. A Git push can trigger a
// Pages preview automatically: stop that build before publishing the new UI.
// main and local builds are unchanged. Revisit only after staging is verified.
if (process.env.CF_PAGES_BRANCH === 'release/cai-market-v1') {
  throw new Error('PREVIEW_BLOCKED: CAI Market V1 requires a verified isolated Supabase and API before publication.')
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
