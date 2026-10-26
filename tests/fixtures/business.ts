import type { BrowserContext } from '@playwright/test'
import { resetDatabase, staffQuery } from '../credit/fixture'
import { createV11Database } from '../credit/v11-fixture'
import { createWorker, type Env } from '../../worker/api/src'
import { products } from '../../src/data/mock'

// Test-only database and Auth boundary. UI -> real Worker -> real SQL RPCs in
// PGlite. No remote endpoints, signatures, production data or credential use.
export function businessFixture(context: BrowserContext, userId: string, role: string) {
  let database: ReturnType<typeof createV11Database> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const objects = new Map<string, ArrayBuffer>()
  const env: Env = { SUPABASE_URL: 'https://cai-auth-test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ALLOWED_ORIGIN: 'http://127.0.0.1:5174', MEDIA: {
    async put(key: string, value: ArrayBuffer) {
      if (objects.has(key)) return null
      objects.set(key, value.slice(0)); return { etag: `test-${objects.size}`, size: value.byteLength }
    },
    async get(key: string) {
      const value = objects.get(key)
      return value ? { body: new Blob([value]).stream(), size: value.byteLength, etag: 'test' } : null
    },
  } }
  function getDatabase() {
    database ??= (async () => {
      const db = await createV11Database()
      await resetDatabase(db, true)
      await db.query('UPDATE pos.customers SET phone=$1 WHERE id=$2', ['3001234567', '20000000-0000-0000-0000-000000000001'])
      await db.query('UPDATE pos.profiles SET role=$1 WHERE id=$2', [role, userId])
      await db.exec('DELETE FROM pos.inventory_balances; DELETE FROM pos.products;')
      for (const [index, product] of products.entries()) {
        const id = `30000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`
        await db.query('INSERT INTO pos.products(id,sku,name,price,category,minimum) VALUES($1,$2,$3,$4,$5,$6)',
          [id, product.id, product.name, product.price, product.category, product.minimum])
        await db.query('INSERT INTO pos.inventory_balances VALUES($1,$2)', [id,product.stock])
      }
      return db
    })()
    return database
  }
  context.on('close', () => { if (database) void database.then(async (db) => { await queue; await db.close() }).catch(() => {}) })
  const api = createWorker(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === '/auth/v1/user') return Response.json({ id: userId })
    const db = await getDatabase()
    const body = JSON.parse(String(init?.body))
    const execute = async () => {
      let evidence: Record<string, unknown> = {}
      try { evidence = JSON.parse(Buffer.from((new Headers(init?.headers).get('Authorization') ?? '').split('.')[1], 'base64url').toString('utf8')) }
      catch { /* Malformed fake credentials have no recent-auth evidence. */ }
      const claims = { sub: userId, role: 'authenticated', exp: 4102444800, session_id: evidence.session_id, amr: evidence.amr }
      if (path.endsWith('/cai_current_profile')) return (await staffQuery(db,'SELECT * FROM public.cai_current_profile()',[],claims)).rows
      if (path.endsWith('/cai_report')) return (await staffQuery<{value:unknown}>(db,'SELECT public.cai_report($1::jsonb) AS value',[JSON.stringify(body.p_data)],claims)).rows[0].value
      const rpc = path.endsWith('/cai_catalog') ? 'cai_catalog' : path.endsWith('/cai_operations') ? 'cai_operations' : null
      if (!rpc) throw new Error('Unexpected test RPC')
      return (await staffQuery<{value:unknown}>(db,`SELECT public.${rpc}($1,$2::jsonb,$3) AS value`,[body.p_action,JSON.stringify(body.p_data),body.p_key],claims)).rows[0].value
    }
    const result = queue.then(execute)
    queue = result.catch(() => {})
    try { return Response.json(await result) }
    catch (cause) {
      const error = cause as { code?: string; message?: string }
      return Response.json({ message:error.message ?? 'TEST_FAILURE' },{ status:error.code==='42501' ? 403 : error.code==='23505' ? 409 : 400 })
    }
  })
  return async (url: string, init: RequestInit) => api.fetch(new Request(url, init), env)
}
