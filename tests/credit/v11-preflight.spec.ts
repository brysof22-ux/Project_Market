import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase, resetDatabase, staffQuery, ids } from './fixture'
import { createV11Database } from './v11-fixture'

async function history(db: PGlite, upgraded: boolean) {
  await db.exec(`CREATE SCHEMA supabase_migrations AUTHORIZATION credit_migrator;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
    ALTER TABLE supabase_migrations.schema_migrations OWNER TO credit_migrator;`)
  for (let version = 1; version <= 8; version++) {
    await db.query('INSERT INTO supabase_migrations.schema_migrations VALUES($1)', [`20261023000${version}00`])
  }
  if (upgraded) await db.exec("INSERT INTO supabase_migrations.schema_migrations VALUES('20261025000900')")
}

test('preflight 009 es de solo lectura, acepta V1 y rechaza restos parciales', async () => {
  const db = await createDatabase()
  try {
    await resetDatabase(db)
    await history(db, false)
    const query = await readFile('supabase/checks/v11_production_preflight.sql', 'utf8')
    const baseline = (await db.query('SELECT to_jsonb(p) AS value FROM pos.profiles p ORDER BY id')).rows
    await db.exec('SET ROLE credit_migrator')
    await db.exec(query)
    await db.exec('RESET ROLE')
    expect((await db.query('SELECT to_jsonb(p) AS value FROM pos.profiles p ORDER BY id')).rows).toEqual(baseline)
    await db.exec('CREATE TABLE pos.operation_state(id boolean)')
    await db.exec('SET ROLE credit_migrator')
    await expect(db.exec(query)).rejects.toThrow('STOP_PARTIAL_009_RELATION')
    await db.exec('ROLLBACK; RESET ROLE;')
  } finally { await db.close() }
})

test('auditoría 009 de solo lectura comprueba períodos activos y archivados sin cambios', async () => {
  const db = await createV11Database()
  try {
    await resetDatabase(db, true)
    await history(db, true)
    const period = '11111111-1111-4111-8111-111111111111'
    const claims = { sub: ids.otherActor, role: 'authenticated', exp: 4102444800,
      session_id: '90000000-0000-4000-8000-000000000001', amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] }
    let key = 0
    async function operation(action: string, data: object, admin = false) {
      const reply = await staffQuery<{ value: Record<string, unknown> }>(db,
        'SELECT public.cai_operations($1,$2::jsonb,$3) AS value', [action, JSON.stringify(data), `readonly-audit-${++key}`],
        admin ? claims : { sub: ids.actor, role: 'authenticated', exp: 4102444800 })
      return reply.rows[0].value
    }
    const cash = (await db.query<{ id: string }>("SELECT id FROM pos.payment_methods WHERE code='cash'")).rows[0].id
    await operation('sale.confirm', { expected_period: period, expected_total: '100.00',
      session_id: ids.session, finance: true, customer_name: 'Persona ficticia de auditoría', customer_phone: '3001234567',
      lines: [{ product_id: ids.product, quantity: 1 }], payments: [{ method_id: cash, amount: '25' }] })
    await operation('cash.close', { expected_period: period, session_id: ids.session, counted: '75' })
    const preview = await operation('reset.preview', { expected_period: period }, true)
    await operation('reset.confirm', { expected_period: period, intent_id: preview.intent_id,
      confirmation: 'REINICIAR OPERACION', reason: 'Auditoría aislada de archivo' }, true)
    expect((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM pos.operating_periods')).rows[0].count).toBe(2)
    const snapshot = await db.query('SELECT to_jsonb(p) AS value FROM pos.profiles p ORDER BY id')
    await db.exec('SET ROLE credit_migrator')
    await db.exec(await readFile('supabase/checks/v11_postmigration_integrity.sql', 'utf8'))
    await db.exec('RESET ROLE')
    expect((await db.query('SELECT to_jsonb(p) AS value FROM pos.profiles p ORDER BY id')).rows).toEqual(snapshot.rows)
    expect((await db.query<{ value: string | null }>("SELECT current_setting('cai.archive_period',true) AS value")).rows[0].value ?? '').toBe('')
  } finally { await db.close() }
})
