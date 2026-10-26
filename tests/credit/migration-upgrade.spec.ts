import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createDatabase, resetDatabase, authorize, sale, receipt } from './fixture'

test('006–008 conservan filas y saldos de una base con ventas y abonos anteriores', async () => {
  const db = await createDatabase(true)
  try {
    await resetDatabase(db)
    await authorize(db, '500')
    await sale(db, '50', 2, 'existing-sale', true)
    await receipt(db, '30')
    await db.exec('SET ROLE credit_migrator;')
    await db.exec(await readFile('supabase/migrations/20261023000500_current_profile_rpc.sql', 'utf8'))
    await db.exec('RESET ROLE;')

    const relations = await db.query<{ name: string }>(`SELECT c.oid::regclass::text AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='pos' AND c.relkind IN ('r','v') ORDER BY 1`)
    const snapshots: { name: string; sql: string; rows: unknown[] }[] = []
    for (const { name } of relations.rows) {
      const columns = await db.query<{ attname: string }>(`SELECT attname FROM pg_attribute
        WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`, [name])
      const projection = columns.rows.map(({ attname }) => '"' + attname.replaceAll('"', '""') + '"').join(',')
      const sql = `SELECT to_jsonb(x)::text AS row FROM (SELECT ${projection} FROM ${name}) x ORDER BY 1`
      snapshots.push({ name, sql, rows: (await db.query(sql)).rows })
    }
    await db.exec('SET ROLE credit_migrator;')
    await db.exec(`CREATE SCHEMA supabase_migrations;
      CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
      INSERT INTO supabase_migrations.schema_migrations VALUES
        ('20261023000100'),('20261023000200'),('20261023000300'),('20261023000400'),('20261023000500');`)
    const preflight = await readFile('supabase/checks/v1_production_preflight.sql', 'utf8')
    await db.exec(preflight)
    const baselineSql = await readFile('supabase/checks/v1_financial_baseline.sql', 'utf8')
    const baseline = await db.exec(baselineSql)
    for (const name of ['20261023000600_catalog', '20261023000700_operations', '20261023000800_reports']) {
      await db.exec(await readFile(`supabase/migrations/${name}.sql`, 'utf8'))
    }
    await db.exec('RESET ROLE;')
    expect(await db.exec(baselineSql)).toEqual(baseline)
    for (const snapshot of snapshots) {
      expect((await db.query(snapshot.sql)).rows, snapshot.name).toEqual(snapshot.rows)
    }
    expect((await db.query(`SELECT outstanding::text AS amount FROM pos.credit_account_balances`)).rows)
      .toEqual([{ amount: '120.00' }])
    expect((await db.query(`SELECT has_schema_privilege('pos_owner','pos','CREATE') AS pos_create,
      has_schema_privilege('pos_owner','public','CREATE') AS public_create`)).rows)
      .toEqual([{ pos_create: false, public_create: false }])
    // Functions/columns without history must never be treated as pending clean SQL.
    await db.exec('SET ROLE credit_migrator;')
    await expect(db.exec(preflight)).rejects.toThrow('STOP_PARTIAL_FUNCTIONS')
    await db.exec('ROLLBACK; RESET ROLE;')
  } finally {
    await db.close()
  }
})
