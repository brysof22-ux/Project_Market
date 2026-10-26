// Public deployment targets authorized for CAI Market production. No credentials.
export const productionTargets = {
  supabase: 'https://sauoekefntzxhqxycdgo.supabase.co',
  api: 'https://cai-market-api.brysof22.workers.dev',
  frontend: 'https://project-market.pages.dev',
} as const

export function invalidProductionSettings(env: Record<string, string | undefined>): string[] {
  const invalid: string[] = []
  if (env.VITE_SUPABASE_URL !== productionTargets.supabase) invalid.push('VITE_SUPABASE_URL')
  if (env.VITE_API_URL !== productionTargets.api) invalid.push('VITE_API_URL')
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ''
  if (!/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)
    || /^sb_publishable_(?:YOUR_|REPLACE_|playwright_|fake_|example|test(?:_|$))/i.test(key)) {
    invalid.push('VITE_SUPABASE_PUBLISHABLE_KEY')
  }
  const allowed = ['VITE_SUPABASE_URL', 'VITE_API_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']
  for (const name of Object.keys(env)) {
    if (name.startsWith('VITE_') && !allowed.includes(name)) invalid.push(name)
  }
  return invalid
}
