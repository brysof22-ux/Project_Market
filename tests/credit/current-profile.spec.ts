import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase, resetDatabase, ids, staffQuery, scalar } from './fixture'

let db: PGlite
test.beforeAll(async () => { db = await createDatabase() })
test.beforeEach(async () => { await resetDatabase(db) })
test.afterAll(async () => { await db?.close() })

test('RPC sin argumentos solo devuelve los cuatro campos del propio administrador activo', async () => {
  const result = await staffQuery(db, 'SELECT * FROM public.cai_current_profile()', [],
    { sub: ids.otherActor, role: 'authenticated', exp: 4102444800 })
  expect(result.rows).toEqual([{ id: ids.otherActor, display_name: 'Otro empleado activo', role: 'admin', active: true }])
  await expect(staffQuery(db, 'SELECT * FROM public.cai_current_profile($1)', [ids.actor])).rejects.toThrow('does not exist')
})

test('perfil ausente o inactivo devuelve cero filas', async () => {
  expect((await staffQuery(db, 'SELECT * FROM public.cai_current_profile()', [],
    { sub: ids.customer, role: 'authenticated', exp: 4102444800 })).rows).toEqual([])
  await db.query('UPDATE pos.profiles SET active=false WHERE id=$1', [ids.actor])
  expect((await staffQuery(db, 'SELECT * FROM public.cai_current_profile()')).rows).toEqual([])
})

test('contexto SQL fabricado, expiración o sujeto ausente no autorizan lectura', async () => {
  await db.query(`SELECT set_config('request.jwt.claims',$1,false)`, [JSON.stringify({ sub: ids.actor, role: 'authenticated', exp: 4102444800 })])
  await db.exec('SET ROLE authenticated')
  await expect(db.query('SELECT * FROM public.cai_current_profile()')).rejects.toThrow('UNTRUSTED_AUTH_CONTEXT')
  await db.exec('RESET ROLE')
  for (const claims of [{ sub: ids.actor, role: 'authenticated', exp: 1 }, { role: 'authenticated', exp: 4102444800 }]) {
    await expect(staffQuery(db, 'SELECT * FROM public.cai_current_profile()', [], claims)).rejects.toThrow('INVALID_AUTH_CONTEXT')
  }
})

test('anon, service_role y roles técnicos sin EXECUTE; sin nuevas lecturas de tablas', async () => {
  for (const role of ['anon', 'service_role', 'pos_app', 'pos_scheduler']) {
    expect(await scalar(db, `SELECT has_function_privilege($1,'public.cai_current_profile()','EXECUTE') AS value`, [role])).toBe(false)
  }
  expect(await scalar(db, `SELECT has_function_privilege('authenticated','public.cai_current_profile()','EXECUTE') AS value`)).toBe(true)
  expect(await scalar(db, `SELECT has_table_privilege('authenticated','pos.profiles','SELECT') AS value`)).toBe(false)
  expect(await scalar(db, `SELECT has_schema_privilege('pos_owner','public','CREATE') AS value`)).toBe(false)
  expect(await scalar(db, `SELECT pg_get_userbyid(proowner) AS value FROM pg_proc WHERE oid='public.cai_current_profile()'::regprocedure`)).toBe('pos_owner')
  expect(await scalar(db, `SELECT proconfig::text AS value FROM pg_proc WHERE oid='public.cai_current_profile()'::regprocedure`)).toContain('search_path=pg_catalog, pg_temp')
})

test('cajero solo consulta su propio perfil y claims de roles privilegiados no autorizan la RPC', async () => {
  const own = await staffQuery(db, 'SELECT * FROM public.cai_current_profile()')
  expect(own.rows).toEqual([{ id: ids.actor, display_name: 'Cajero de prueba', role: 'cashier', active: true }])
  for (const role of ['anon', 'service_role', 'pos_owner']) {
    await expect(staffQuery(db, 'SELECT * FROM public.cai_current_profile()', [],
      { sub: ids.actor, role, exp: 4102444800 })).rejects.toThrow('INVALID_AUTH_CONTEXT')
  }
})

test('empleado no puede leer perfiles directamente ni alterar roles mediante la RPC', async () => {
  await expect(staffQuery(db, 'SELECT * FROM pos.profiles')).rejects.toThrow('permission denied')
  await expect(staffQuery(db, "UPDATE pos.profiles SET role='admin' WHERE id=$1", [ids.actor])).rejects.toThrow('permission denied')
  expect(await scalar(db, 'SELECT role AS value FROM pos.profiles WHERE id=$1', [ids.actor])).toBe('cashier')
})

test('authenticated no ejecuta helpers administrativos ni el scheduler privado', async () => {
  const result = await db.query<{ name: string }>(`SELECT p.proname AS name FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pos'
    AND has_function_privilege('authenticated',p.oid,'EXECUTE') ORDER BY p.proname`)
  expect(result.rows.map((row) => row.name)).toEqual([
    'authorize_credit_limit', 'confirm_sale', 'credit_summary', 'get_credit_account',
    'get_credit_history', 'list_credits', 'record_communication_consent',
    'record_credit_receipt', 'set_whatsapp_contact',
  ])
})


test('puente privado funciona sin delegar USAGE de auth y no amplía ACL ni propietarios financieros', async () => {
  expect(await scalar(db, `SELECT has_schema_privilege('credit_migrator','auth','USAGE WITH GRANT OPTION') AS value`)).toBe(false)
  expect(await scalar(db, `SELECT has_schema_privilege('pos_owner','auth','USAGE') AS value`)).toBe(false)
  expect(await scalar(db, `SELECT has_function_privilege('pos_owner','auth.uid()','EXECUTE') AS value`)).toBe(true)
  await db.exec('SET ROLE pos_owner')
  await expect(db.query('SELECT auth.uid()')).rejects.toThrow('permission denied for schema auth')
  await db.exec('RESET ROLE')
  for (const role of ['anon', 'authenticated', 'service_role', 'pos_app', 'pos_scheduler']) {
    expect(await scalar(db, `SELECT has_function_privilege($1,'pos.current_profile_auth_uid()','EXECUTE') AS value`, [role])).toBe(false)
  }
  expect(await scalar(db, `SELECT has_function_privilege('pos_owner','pos.current_profile_auth_uid()','EXECUTE') AS value`)).toBe(true)
  expect(await scalar(db, `SELECT pg_get_userbyid(proowner) AS value FROM pg_proc WHERE oid='pos.current_profile_auth_uid()'::regprocedure`)).toBe('credit_migrator')
  expect(await scalar(db, `SELECT count(*)::integer AS value FROM pg_tables WHERE schemaname='pos' AND tableowner<>'pos_owner'`)).toBe(0)
  await expect(staffQuery(db, 'SELECT pos.current_profile_auth_uid()')).rejects.toThrow('permission denied')
  expect((await staffQuery(db, 'SELECT * FROM public.cai_current_profile()')).rows).toHaveLength(1)
})

test('sujeto legacy ajeno no prevalece sobre el JWT y entradas malformadas no revelan perfiles', async () => {
  await db.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`, [ids.otherActor])
  try {
    await expect(staffQuery(db, 'SELECT * FROM public.cai_current_profile()')).rejects.toThrow('INVALID_AUTH_CONTEXT')
  } finally {
    await db.query(`SELECT set_config('request.jwt.claim.sub','',false)`)
  }
  for (const claims of [
    { sub: ids.actor, role: 'authenticated' },
    { sub: 'not-a-uuid', role: 'authenticated', exp: 4102444800 },
    { sub: ids.actor, role: 'authenticated', exp: 'invalid' },
    { sub: ids.actor, role: 'authenticated', exp: 0 },
  ]) {
    await expect(staffQuery(db, 'SELECT * FROM public.cai_current_profile()', [], claims)).rejects.toThrow()
  }
})

test('fallo original de GRANT se reproduce sin superusuario y revierte toda la transacción', async () => {
  const isolated = await createDatabase(true)
  try {
    await isolated.exec('SET ROLE credit_migrator')
    await expect(isolated.exec(`BEGIN;
      GRANT USAGE ON SCHEMA auth TO pos_owner;
      DO $$ BEGIN
        IF NOT has_schema_privilege('pos_owner','auth','USAGE') THEN
          RAISE EXCEPTION 'ADMINISTRATOR_CANNOT_GRANT_AUTH_USAGE';
        END IF;
      END $$;
      GRANT CREATE ON SCHEMA public TO pos_owner;
      COMMIT;`)).rejects.toThrow('ADMINISTRATOR_CANNOT_GRANT_AUTH_USAGE')
    await isolated.exec('ROLLBACK; RESET ROLE;')
    expect(await scalar(isolated, `SELECT to_regprocedure('public.cai_current_profile()') AS value`)).toBeNull()
    expect(await scalar(isolated, `SELECT to_regprocedure('pos.current_profile_auth_uid()') AS value`)).toBeNull()
    expect(await scalar(isolated, `SELECT has_schema_privilege('pos_owner','public','CREATE') AS value`)).toBe(false)
    expect(await scalar(isolated, `SELECT has_schema_privilege('pos_owner','auth','USAGE') AS value`)).toBe(false)
    // A late error must also roll back the new helper, RPC and temporary grants.
    const migration = await readFile('supabase/migrations/20261023000500_current_profile_rpc.sql', 'utf8')
    await isolated.exec('SET ROLE credit_migrator')
    await expect(isolated.exec(migration.replace('COMMIT;', () => `DO $$ BEGIN RAISE EXCEPTION 'INJECTED_LATE_FAILURE'; END $$; COMMIT;`))).rejects.toThrow('INJECTED_LATE_FAILURE')
    await isolated.exec('ROLLBACK; RESET ROLE;')
    expect(await scalar(isolated, `SELECT to_regprocedure('public.cai_current_profile()') AS value`)).toBeNull()
    expect(await scalar(isolated, `SELECT to_regprocedure('pos.current_profile_auth_uid()') AS value`)).toBeNull()
    expect(await scalar(isolated, `SELECT has_schema_privilege('pos_owner','public','CREATE') AS value`)).toBe(false)
    const preflight = await readFile('supabase/checks/current_profile_preflight.sql', 'utf8')
    await isolated.exec('SET ROLE credit_migrator')
    await isolated.exec(preflight)
    await isolated.exec(migration)
    await isolated.exec('RESET ROLE; SET ROLE credit_migrator;')
    await isolated.exec(await readFile('supabase/checks/current_profile_audit.sql', 'utf8'))
  } finally { await isolated.close() }
})

test('005 aborta si está registrada o existe una RPC previa, sin reemplazar objetos', async () => {
  const migration = await readFile('supabase/migrations/20261023000500_current_profile_rpc.sql', 'utf8')
  await db.exec(`CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
    INSERT INTO supabase_migrations.schema_migrations VALUES ('20261023000500');`)
  try {
    await expect(db.exec(migration)).rejects.toThrow('MIGRATION_005_ALREADY_RECORDED')
    await db.exec('ROLLBACK')
    await db.exec(`DELETE FROM supabase_migrations.schema_migrations`)
    await expect(db.exec(migration)).rejects.toThrow('REVIEW_EXISTING_PROFILE_RPC_OR_HELPER')
    await db.exec('ROLLBACK')
    expect(await scalar(db, `SELECT pg_get_userbyid(proowner) AS value FROM pg_proc WHERE oid='public.cai_current_profile()'::regprocedure`)).toBe('pos_owner')
  } finally { await db.exec('ROLLBACK; DROP SCHEMA supabase_migrations CASCADE;') }
})
