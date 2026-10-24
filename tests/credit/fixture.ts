import { PGlite } from '@electric-sql/pglite'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const ids = {
  actor: '10000000-0000-0000-0000-000000000001',
  otherActor: '10000000-0000-0000-0000-000000000002',
  customer: '20000000-0000-0000-0000-000000000001',
  otherCustomer: '20000000-0000-0000-0000-000000000002',
  product: '30000000-0000-0000-0000-000000000001',
  session: '40000000-0000-0000-0000-000000000001',
}

export async function createDatabase(beforeProfile = false) {
  const db = new PGlite()
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid $$;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE ROLE authenticator NOLOGIN NOINHERIT; GRANT authenticated TO authenticator;`)
  // Exercise CREATE ROLE and ownership transfers without superuser privileges.
  await db.exec(`CREATE ROLE credit_migrator NOLOGIN CREATEROLE NOSUPERUSER;
    GRANT CREATE ON DATABASE postgres TO credit_migrator;
    GRANT USAGE ON SCHEMA auth TO credit_migrator;
    GRANT USAGE, CREATE ON SCHEMA public TO credit_migrator WITH GRANT OPTION;
    GRANT REFERENCES ON auth.users TO credit_migrator;
    SET ROLE credit_migrator;`)
  const directory = path.resolve('supabase/migrations')
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith('.sql') && (!beforeProfile || name < '20261023000500'))
    .sort()) {
    await db.exec(await readFile(path.join(directory, name), 'utf8'))
  }
  await db.exec('RESET ROLE')
  await db.exec(`CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE
    SET search_path = pg_catalog AS $$ SELECT timestamptz '2026-10-23 15:00:00+00' $$;`)
  // Keep test-only defaults on the same clock as financial commands/reports.
  await db.exec(`ALTER TABLE pos.cash_sessions ALTER COLUMN opened_at SET DEFAULT pos.business_now();
    ALTER TABLE pos.payments ALTER COLUMN created_at SET DEFAULT pos.business_now();`)
  return db
}

export async function resetDatabase(db: PGlite) {
  await db.exec('RESET ROLE')
  await db.exec(`CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE
    SET search_path = pg_catalog AS $$ SELECT timestamptz '2026-10-23 15:00:00+00' $$;`)
  const tables = await db.query<{
    name: string
  }>(`SELECT quote_ident(schemaname)||'.'||quote_ident(tablename) AS name
    FROM pg_tables WHERE schemaname IN ('pos','auth')`)
  await db.exec(
    `TRUNCATE ${tables.rows.map((row) => row.name).join(',')} RESTART IDENTITY CASCADE`,
  )
  await db.exec(`INSERT INTO auth.users VALUES('${ids.actor}'),('${ids.otherActor}');
    INSERT INTO pos.profiles(id, display_name, role) VALUES('${ids.actor}', 'Cajero de prueba', 'cashier'),
      ('${ids.otherActor}', 'Otro empleado activo', 'admin');
    INSERT INTO pos.customers(id, name) VALUES('${ids.customer}','Cliente de prueba'),('${ids.otherCustomer}','Otro cliente');
    INSERT INTO pos.products(id,sku,name,price) VALUES('${ids.product}','TEST','Producto',100);
    INSERT INTO pos.inventory_balances VALUES('${ids.product}',100);
    INSERT INTO pos.cash_sessions(id,operator_id,opening_float) VALUES('${ids.session}','${ids.actor}',50);
    INSERT INTO pos.payment_methods(code,name,affects_cash,requires_reference)
      VALUES('cash','Efectivo',true,false),('transfer','Transferencia',false,true);`)
}

export async function scalar<T = unknown>(
  db: PGlite,
  sql: string,
  parameters: unknown[] = [],
) {
  // Financial fixture calls emulate ONLY the database context of PostgREST.
  // This does not verify a JWT signature. Negative auth tests use db.query directly.
  const staffCall = /\bpos\.(authorize_credit_limit|confirm_sale|record_credit_receipt|get_credit_account|list_credits|credit_summary|set_whatsapp_contact|get_credit_history|record_communication_consent)\s*\(/.test(sql)
  const result = staffCall
    ? await staffQuery<{ value: T }>(db, sql, parameters)
    : await db.query<{ value: T }>(sql, parameters)
  return result.rows[0]?.value
}

export async function staffQuery<T>(db: PGlite, sql: string, parameters: unknown[] = [],
  claims: Record<string, unknown> = { sub: ids.actor, role: 'authenticated', exp: 4102444800 },
  isolation: 'read committed' | 'repeatable read' = 'read committed') {
  try {
    return await db.transaction(async (tx) => {
      await tx.exec(`SET TRANSACTION ISOLATION LEVEL ${isolation}`)
      await tx.exec('SET SESSION AUTHORIZATION authenticator; SET LOCAL ROLE authenticated;')
      await tx.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify(claims)])
      return tx.query<T>(sql, parameters)
    })
  } finally {
    // PGlite preserves session identity between protocol calls. Restore explicitly.
    await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE;')
  }
}

export async function authorize(
  db: PGlite,
  amount = '1000',
  key = 'limit-1',
  customer = ids.customer,
) {
  return scalar<Record<string, string>>(
    db,
    `SELECT pos.authorize_credit_limit($1,$2,$3,'Autorización presencial',$4) AS value`,
    [ids.actor, customer, amount, key],
  )
}

export async function sale(
  db: PGlite,
  paid = '0',
  quantity = 1,
  key = 'sale-1',
  finance = true,
) {
  const cash = await scalar<string>(
    db,
    `SELECT id AS value FROM pos.payment_methods WHERE code='cash'`,
  )
  return scalar<Record<string, string>>(
    db,
    `SELECT pos.confirm_sale($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7) AS value`,
    [
      ids.actor,
      ids.customer,
      ids.session,
      JSON.stringify([{ product_id: ids.product, quantity }]),
      JSON.stringify(
        Number(paid) > 0 ? [{ method_id: cash, amount: paid }] : [],
      ),
      finance,
      key,
    ],
  )
}

export async function receipt(
  db: PGlite,
  amount: string,
  key = 'receipt-1',
  method = 'cash',
) {
  const methodId = await scalar<string>(
    db,
    `SELECT id AS value FROM pos.payment_methods WHERE code=$1`,
    [method],
  )
  return scalar<Record<string, string>>(
    db,
    `SELECT pos.record_credit_receipt($1,$2,$3,$4,$5,$6,$7) AS value`,
    [
      ids.actor,
      ids.customer,
      ids.session,
      amount,
      methodId,
      method === 'transfer' ? 'TR-TEST' : null,
      key,
    ],
  )
}

export async function contact(db: PGlite, consent = true) {
  await staffQuery(db, `SELECT pos.set_whatsapp_contact($1,$2,'+573001234567')`, [
    ids.actor,
    ids.customer,
  ])
  await db.query(`SELECT pos.verify_whatsapp_contact($1,'+573001234567')`, [
    ids.customer,
  ])
  if (consent)
    await staffQuery(db,
      `SELECT pos.record_communication_consent($1,$2,'+573001234567',true,'presencial','Consentimiento ficticio de prueba')`,
      [ids.actor, ids.customer],
    )
}

export const reminderTime = '2026-10-28T14:00:00Z'
