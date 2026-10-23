import { test, expect } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import {
  authorize,
  contact,
  createDatabase,
  ids,
  receipt,
  reminderTime,
  resetDatabase,
  sale,
  scalar,
  staffQuery,
} from './fixture'
import {
  MockWhatsAppTransport,
  runDryRunBatch,
  type Dispatch,
  type ReminderRepository,
} from '../../worker/credit-reminders/dry-run'

let db: PGlite
test.beforeAll(async () => {
  db = await createDatabase()
})
test.beforeEach(async () => {
  await resetDatabase(db)
})
test.afterAll(async () => {
  await db?.close()
})

async function debt() {
  return Number(
    await scalar(
      db,
      'SELECT outstanding AS value FROM pos.credit_account_balances WHERE customer_id=$1',
      [ids.customer],
    ),
  )
}
async function claim(at = reminderTime) {
  return scalar<Record<string, string> | null>(
    db,
    'SELECT pos.claim_credit_reminder($1) AS value',
    [at],
  )
}
async function enqueue(at = reminderTime) {
  return scalar<number>(
    db,
    'SELECT pos.enqueue_credit_reminders($1) AS value',
    [at],
  )
}
async function finish(
  token: string,
  outcome: string,
  at = reminderTime,
  messageId: string | null = null,
) {
  return scalar<string>(
    db,
    'SELECT pos.finish_credit_reminder($1,$2,$3,NULL,$4) AS value',
    [token, outcome, messageId, at],
  )
}

test('venta financiada no inventa efectivo y conserva responsable e inventario', async () => {
  await authorize(db)
  const result = await saleAsApp()
  expect(result?.financed).toBe('100.00')
  await db.exec('RESET ROLE')
  expect(await debt()).toBe(100)
  expect(
    Number(await scalar(db, 'SELECT count(*) AS value FROM pos.payments')),
  ).toBe(0)
  expect(
    Number(await scalar(db, 'SELECT count(*) AS value FROM pos.cash_entries')),
  ).toBe(0)
  expect(
    Number(
      await scalar(db, 'SELECT quantity AS value FROM pos.inventory_balances'),
    ),
  ).toBe(99)
  expect(await scalar(db, 'SELECT created_by AS value FROM pos.sales')).toBe(
    ids.actor,
  )
})
async function saleAsApp() {
  return scalar<Record<string, string>>(
    db,
    `SELECT pos.confirm_sale($1,$2,$3,$4::jsonb,'[]',true,'app-sale') AS value`,
    [
      ids.actor,
      ids.customer,
      ids.session,
      JSON.stringify([{ product_id: ids.product, quantity: 1 }]),
    ],
  )
}

test('pago mixto y abono inicial: solo lo recibido entra a caja y recaudo', async () => {
  await authorize(db)
  const result = await sale(db, '30')
  expect(Number(result?.financed)).toBe(70)
  expect(await debt()).toBe(70)
  expect(
    Number(
      await scalar(db, 'SELECT sum(amount) AS value FROM pos.cash_entries'),
    ),
  ).toBe(30)
  const summary = await scalar<Record<string, string>>(
    db,
    'SELECT pos.credit_summary($1,$2) AS value',
    [ids.actor, '2026-10-01'],
  )
  expect(Number(summary?.monthly_collections)).toBe(30)
})

test('abono parcial efectivo y saldo calculado', async () => {
  await authorize(db)
  await sale(db)
  await receipt(db, '35')
  expect(await debt()).toBe(65)
  expect(
    Number(
      await scalar(db, 'SELECT sum(amount) AS value FROM pos.cash_entries'),
    ),
  ).toBe(35)
  expect(
    await scalar(db, 'SELECT received_by AS value FROM pos.credit_receipts'),
  ).toBe(ids.actor)
})

test('pago completo por transferencia salda sin aumentar efectivo', async () => {
  await authorize(db)
  await sale(db)
  await receipt(db, '100', 'full', 'transfer')
  expect(await debt()).toBe(0)
  expect(
    await scalar(db, 'SELECT status AS value FROM pos.credit_charge_balances'),
  ).toBe('paid')
  expect(
    await scalar(
      db,
      'SELECT settled_at IS NOT NULL AS value FROM pos.credit_charge_balances',
    ),
  ).toBe(true)
  expect(
    Number(await scalar(db, 'SELECT count(*) AS value FROM pos.cash_entries')),
  ).toBe(0)
})

test('deudas acumuladas y distribución FIFO', async () => {
  await authorize(db)
  const first = await sale(db, '0', 1, 'first')
  // Deterministic ordering between purchases, still within the confirmed policy.
  await db.exec(
    `CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT timestamptz '2026-10-24 15:00Z' $$`,
  )
  const second = await sale(db, '0', 1, 'second')
  await receipt(db, '130')
  expect(await debt()).toBe(70)
  const rows = await db.query<{ id: string; outstanding: string }>(
    'SELECT id, outstanding FROM pos.credit_charge_balances',
  )
  expect(
    Number(rows.rows.find((row) => row.id === first?.charge_id)?.outstanding),
  ).toBe(0)
  expect(
    Number(rows.rows.find((row) => row.id === second?.charge_id)?.outstanding),
  ).toBe(70)
})

test('cupo insuficiente revierte venta, inventario, pagos y auditoría de venta', async () => {
  await authorize(db, '50')
  await expect(sale(db)).rejects.toThrow('CREDIT_LIMIT_EXCEEDED')
  expect(
    Number(await scalar(db, 'SELECT count(*) AS value FROM pos.sales')),
  ).toBe(0)
  expect(
    Number(
      await scalar(db, 'SELECT quantity AS value FROM pos.inventory_balances'),
    ),
  ).toBe(100)
  expect(
    Number(
      await scalar(
        db,
        `SELECT count(*) AS value FROM pos.audit_events WHERE action='sale.confirmed'`,
      ),
    ),
  ).toBe(0)
})

test('ampliación de cupo por cajero conserva historial y rechaza bajar debajo de deuda', async () => {
  await authorize(db, '100')
  await sale(db)
  await expect(authorize(db, '50', 'decrease')).rejects.toThrow(
    'LIMIT_BELOW_DEBT',
  )
  await authorize(db, '200', 'increase')
  expect(
    Number(
      await scalar(
        db,
        'SELECT count(*) AS value FROM pos.credit_limit_authorizations',
      ),
    ),
  ).toBe(2)
  expect(
    Number(
      await scalar(
        db,
        'SELECT available AS value FROM pos.credit_account_balances',
      ),
    ),
  ).toBe(100)
  await expect(
    db.exec('UPDATE pos.credit_limit_authorizations SET new_limit=999'),
  ).rejects.toThrow('IMMUTABLE_FINANCIAL_RECORD')
})

const dueCases = [
  ['2026-10-05','2026-10-28'], ['2026-10-28','2026-10-28'],
  ['2026-10-29','2026-11-28'], ['2026-10-30','2026-11-28'],
  ['2026-10-31','2026-11-28'], ['2026-11-30','2026-12-28'],
  ['2026-12-28','2026-12-28'], ['2026-12-29','2027-01-28'],
  ['2026-12-30','2027-01-28'], ['2026-12-31','2027-01-28'],
  ['2027-01-31','2027-02-28'], ['2026-02-28','2026-02-28'],
  ['2028-02-29','2028-03-28'], ['2026-04-30','2026-05-28'],
]
for (const [purchase, due] of dueCases) {
  test('due date '+purchase+' -> '+due, async () => {
    expect(await scalar(db, 'SELECT pos.credit_due_date($1)::text AS value', [purchase])).toBe(due)
    await authorize(db)
    await db.exec(`CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE
      SET search_path = pg_catalog AS $$ SELECT timestamptz '${purchase} 15:00Z' $$`)
    await sale(db)
    expect(await scalar(db,'SELECT due_on::text AS value FROM pos.credit_charges')).toBe(due)
    expect(await scalar(db,'SELECT purchased_on::text AS value FROM pos.credit_charges')).toBe(purchase)
    expect(await debt()).toBe(100)
  })
}

test('la restricción rechaza vencimiento anterior y meses incorrectos', async () => {
  await authorize(db)
  await sale(db)
  for (const due of ['2026-10-27', '2026-11-28', '2026-09-28']) {
    await expect(db.query(`INSERT INTO pos.credit_charges
      (account_id, customer_id, sale_id, principal, authorization_id, purchased_on, due_on)
      SELECT account_id, customer_id, sale_id, principal, authorization_id, purchased_on, $1
      FROM pos.credit_charges`, [due])).rejects.toThrow('credit_charges_due_policy')
  }
  for (const date of [null, 'infinity', '-infinity']) {
    await expect(scalar(db, 'SELECT pos.credit_due_date($1) AS value', [date])).rejects.toThrow('INVALID_PURCHASE_DATE')
  }
})

test('medianoche de Bogotá decide entre el 28 actual y el del mes siguiente', async () => {
  await authorize(db)
  for (const [instant, due] of [
    ['2026-10-29 04:59:59Z', '2026-10-28'],
    ['2026-10-29 05:00:00Z', '2026-11-28'],
  ]) {
    await db.exec(`CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE
      SET search_path = pg_catalog AS $$ SELECT timestamptz '${instant}' $$`)
    const result = await sale(db, '0', 1, instant)
    expect(await scalar(db,'SELECT due_on::text AS value FROM pos.credit_charges WHERE id=$1', [result?.charge_id])).toBe(due)
  }
})

test('recordatorio de noviembre acumula compras de octubre y noviembre, sin duplicarse', async () => {
  await authorize(db)
  for (const purchase of ['2026-10-29', '2026-11-10']) {
    await db.exec(`CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE
      SET search_path = pg_catalog AS $$ SELECT timestamptz '${purchase} 15:00Z' $$`)
    await sale(db, '0', 1, purchase)
  }
  await receipt(db, '25')
  await contact(db)
  const at = '2026-11-28T14:00:00Z'
  expect(await enqueue(at)).toBe(1)
  expect(await enqueue(at)).toBe(0)
  expect(Number((await claim(at))?.amount)).toBe(175)
  expect(await claim(at)).toBeNull()
})

test('p_actor no puede reemplazar al sujeto del JWT en ninguna operación de personal', async () => {
  const calls: [string, unknown[]][] = [
    ['SELECT pos.authorize_credit_limit($1,$2,100,\'test\',\'spoof\')', [ids.customer]],
    ['SELECT pos.confirm_sale($1,$2,$3,\'[]\',\'[]\',true,\'spoof\')', [ids.customer, ids.session]],
    ['SELECT pos.record_credit_receipt($1,$2,$3,10,$4,NULL,\'spoof\')', [ids.customer, ids.session, ids.product]],
    ['SELECT pos.get_credit_account($1,$2)', [ids.customer]],
    ['SELECT pos.get_credit_history($1,$2)', [ids.customer]],
    ['SELECT pos.list_credits($1)', []],
    ['SELECT pos.credit_summary($1,\'2026-10-01\')', []],
    ['SELECT pos.set_whatsapp_contact($1,$2,\'+573001234567\')', [ids.customer]],
    ['SELECT pos.record_communication_consent($1,$2,\'+573001234567\',true,\'test\',\'test\')', [ids.customer]],
  ]
  for (const [sql, parameters] of calls) {
    await expect(staffQuery(db, sql, [ids.otherActor, ...parameters])).rejects.toThrow('FORBIDDEN_ACTOR')
  }
  expect(Number(await scalar(db, 'SELECT count(*) AS value FROM pos.audit_events'))).toBe(0)
})

test('JWT sin sujeto, vencido o de rol técnico no autoriza créditos', async () => {
  for (const claims of [
    { role: 'authenticated', exp: 4102444800 },
    { sub: ids.actor, role: 'authenticated', exp: 1 },
    { sub: ids.actor, role: 'authenticated' },
    { sub: ids.actor, role: 'service_role', exp: 4102444800 },
    { sub: ids.actor, exp: 4102444800 },
  ]) {
    await expect(staffQuery(db, `SELECT pos.authorize_credit_limit($1,$2,100,'test','bad-jwt')`,
      [ids.actor, ids.customer], claims)).rejects.toThrow('FORBIDDEN_ACTOR')
  }
})

test('una conexión SQL no puede fabricar identidad configurando request.jwt.claims', async () => {
  await db.query(`SELECT set_config('request.jwt.claims',$1,false)`, [JSON.stringify({ sub: ids.actor, role: 'authenticated', exp: 4102444800 })])
  await db.exec('SET ROLE pos_app')
  await expect(db.query(`SELECT pos.authorize_credit_limit($1,$2,100,'test','forged-guc')`,
    [ids.actor, ids.customer])).rejects.toThrow('UNTRUSTED_AUTH_CONTEXT')
  await db.exec('RESET ROLE')
  expect(await scalar(db, `SELECT pg_has_role('pos_app','pos_owner','MEMBER') AS value`)).toBe(false)
})

test('propiedad, RLS y SECURITY DEFINER conservan privilegios mínimos', async () => {
  const unsafe = await scalar(db, `SELECT count(*) AS value FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pos' AND (pg_get_userbyid(p.proowner)<>'pos_owner'
      OR (p.prosecdef AND NOT ('search_path=pg_catalog, pos, pg_temp'=ANY(p.proconfig)))
      OR has_function_privilege('anon',p.oid,'EXECUTE')
      OR has_function_privilege('service_role',p.oid,'EXECUTE'))`)
  expect(Number(unsafe)).toBe(0)
  expect(Number(await scalar(db, `SELECT count(*) AS value FROM pg_tables
    WHERE schemaname='pos' AND (tableowner<>'pos_owner' OR NOT rowsecurity)`))).toBe(0)
  for (const role of ['pos_app', 'pos_scheduler', 'authenticated']) {
    expect(await scalar(db, `SELECT has_schema_privilege($1,'pos','CREATE') AS value`, [role])).toBe(false)
    expect(Number(await scalar(db, `SELECT count(*) AS value FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND c.relkind IN ('r','v')
      AND has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')`, [role]))).toBe(0)
    expect(await scalar(db, `SELECT pg_has_role($1,'pos_owner','MEMBER') AS value`, [role])).toBe(false)
  }
  expect(await scalar(db, `SELECT rolsuper AS value FROM pg_roles WHERE rolname='credit_migrator'`)).toBe(false)
})

test('proveedor real bloqueado incluso en eventos simulados', async () => {
  await expect(scalar(db, `SELECT pos.record_reminder_delivery('meta','event','message','read',$1) AS value`,
    [reminderTime])).rejects.toThrow('INVALID_DELIVERY_EVENT')
})

test('rechaza snapshots repetibles que podrían conservar una cartera desactualizada', async () => {
  await expect(staffQuery(db, `SELECT pos.authorize_credit_limit($1,$2,100,'test','isolation')`,
    [ids.actor, ids.customer], { sub: ids.actor, role: 'authenticated', exp: 4102444800 },
    'repeatable read')).rejects.toThrow('READ_COMMITTED_REQUIRED')
})

test('sin abonos el crédito vence desde el 29, no durante el 28', async () => {
  await authorize(db)
  await sale(db)
  await db.exec(
    `CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT timestamptz '2026-10-29 04:59:59Z' $$`,
  )
  expect(
    await scalar(db, 'SELECT status AS value FROM pos.credit_charge_balances'),
  ).toBe('active')
  await db.exec(
    `CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT timestamptz '2026-10-29 05:00:00Z' $$`,
  )
  expect(
    await scalar(db, 'SELECT status AS value FROM pos.credit_charge_balances'),
  ).toBe('overdue')
})

test('abonos inválidos, sobrepago e idempotencia', async () => {
  await authorize(db)
  await sale(db)
  for (const amount of ['0', '-1', '0.001', 'NaN', 'Infinity', '101'])
    await expect(receipt(db, amount)).rejects.toThrow()
  const first = await receipt(db, '20')
  expect(await receipt(db, '20')).toEqual(first)
  await expect(receipt(db, '30')).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  expect(await debt()).toBe(80)
  expect(
    Number(
      await scalar(db, 'SELECT count(*) AS value FROM pos.credit_receipts'),
    ),
  ).toBe(1)
})

test('una venta repetida no consume stock o cupo otra vez', async () => {
  await authorize(db)
  const first = await sale(db)
  expect(await sale(db)).toEqual(first)
  expect(await debt()).toBe(100)
  expect(
    Number(
      await scalar(db, 'SELECT quantity AS value FROM pos.inventory_balances'),
    ),
  ).toBe(99)
})

test('un recordatorio por cliente/mes agrupa la deuda total', async () => {
  await authorize(db)
  await sale(db, '0', 1, 'first')
  await sale(db, '0', 2, 'second')
  await contact(db)
  expect(await enqueue()).toBe(1)
  expect(await enqueue()).toBe(0)
  const job = await claim()
  expect(Number(job?.amount)).toBe(300)
  expect(job?.provider).toBe('mock')
  expect(await claim()).toBeNull()
})

test('cliente sin deuda no entra a la cola', async () => {
  await authorize(db)
  await sale(db)
  await receipt(db, '100')
  expect(await enqueue()).toBe(0)
})

test('cliente sin consentimiento no prepara un envío', async () => {
  await authorize(db)
  await sale(db)
  await contact(db, false)
  await enqueue()
  expect((await claim())?.reason).toBe('no_consent')
  expect(
    Number(
      await scalar(db, 'SELECT count(*) AS value FROM pos.reminder_attempts'),
    ),
  ).toBe(0)
})

test('pago completo antes de reservar envío suprime el recordatorio', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  await enqueue()
  await receipt(db, '100')
  expect((await claim())?.reason).toBe('no_debt')
})

test('revocar consentimiento o cambiar número impide usar permiso antiguo', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  await enqueue()
  await staffQuery(db, `SELECT pos.record_communication_consent($1,$2,'+573001234567',false,'presencial','Revocación de prueba')`,
    [ids.actor, ids.customer],
  )
  expect((await claim())?.reason).toBe('no_consent')
  await db.exec(`UPDATE pos.credit_reminders SET status='queued'`)
  await staffQuery(db, `SELECT pos.set_whatsapp_contact($1,$2,'+573009876543')`, [
    ids.actor,
    ids.customer,
  ])
  expect((await claim())?.reason).toBe('unverified_contact')
})

test('reintentos controlados, aceptación idempotente y sin reenvío', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  await enqueue()
  const one = await claim()
  expect(await finish(one!.dispatch_token, 'rejected_retryable')).toBe(
    'retry_wait',
  )
  expect(await claim('2026-10-28T14:04:00Z')).toBeNull()
  const two = await claim('2026-10-28T14:05:00Z')
  expect(
    await finish(
      two!.dispatch_token,
      'accepted',
      '2026-10-28T14:05:00Z',
      'mock-message-1',
    ),
  ).toBe('accepted')
  expect(
    await finish(
      two!.dispatch_token,
      'accepted',
      '2026-10-28T14:06:00Z',
      'mock-message-1',
    ),
  ).toBe('accepted')
  expect(await claim('2026-10-28T15:00:00Z')).toBeNull()
})

test('resultado ambiguo no se reintenta, ni el próximo día', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  await enqueue()
  const job = await claim()
  expect(await finish(job!.dispatch_token, 'unknown')).toBe('unknown')
  expect(await claim('2026-10-28T15:00:00Z')).toBeNull()
  expect(await claim('2026-10-29T14:00:00Z')).toBeNull()
})

test('el programador respeta fecha local y ventana horaria', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  expect(await enqueue('2026-10-28T03:00:00Z')).toBe(0) // aún 27 en Bogotá
  await enqueue()
  expect(await claim('2026-10-28T13:59:59Z')).toBeNull()
  expect(await claim('2026-10-28T23:00:00Z')).toBeNull()
})

test('roles técnicos y navegador no pueden modificar saldos o falsificar verificación', async () => {
  await authorize(db)
  await db.exec('SET ROLE pos_app')
  await expect(
    db.exec('UPDATE pos.inventory_balances SET quantity=999'),
  ).rejects.toThrow('permission denied')
  await expect(
    db.query(`SELECT pos.verify_whatsapp_contact($1,'+573001234567')`, [
      ids.customer,
    ]),
  ).rejects.toThrow('permission denied')
  await db.exec('RESET ROLE; SET ROLE anon')
  await expect(
    db.exec('SELECT * FROM pos.credit_account_balances'),
  ).rejects.toThrow('permission denied')
  await db.exec('RESET ROLE; SET ROLE pos_scheduler')
  await expect(
    db.query(`SELECT pos.authorize_credit_limit($1,$2,100,'test','k')`, [
      ids.actor,
      ids.customer,
    ]),
  ).rejects.toThrow('permission denied')
})

test('usuario inactivo no autoriza cupos ni registra ventas', async () => {
  await db.query('UPDATE pos.profiles SET active=false WHERE id=$1', [
    ids.actor,
  ])
  await expect(authorize(db)).rejects.toThrow('FORBIDDEN')
})

test('restricciones diferidas rechazan un abono sin distribución', async () => {
  await authorize(db)
  await sale(db)
  await expect(
    db.query(
      `INSERT INTO pos.credit_receipts(account_id, amount, method_id, affects_cash_snapshot, cash_session_id, received_by)
    SELECT a.id,10,m.id,false,$1,$2 FROM pos.credit_accounts a CROSS JOIN pos.payment_methods m WHERE m.code='transfer'`,
      [ids.session, ids.actor],
    ),
  ).rejects.toThrow('RECEIPT_ALLOCATION_INTEGRITY_ERROR')
})

test('pago después de reservar pero antes del transporte cancela el despacho', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  await enqueue()
  const job = await claim()
  await receipt(db, '100')
  const preflight = await scalar<Record<string, string>>(
    db,
    'SELECT pos.preflight_credit_reminder($1,$2) AS value',
    [job!.dispatch_token, reminderTime],
  )
  expect(preflight?.reason).toBe('no_debt')
  expect(await claim()).toBeNull()
  expect(
    await scalar(db, 'SELECT outcome AS value FROM pos.reminder_attempts'),
  ).toBe('cancelled')
})

test('el importe se recalcula justo antes del transporte si se registra un abono', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  await enqueue()
  const job = await claim()
  await receipt(db, '25')
  const preflight = await scalar<Record<string, string>>(
    db,
    'SELECT pos.preflight_credit_reminder($1,$2) AS value',
    [job!.dispatch_token, reminderTime],
  )
  expect(Number(preflight?.amount)).toBe(75)
})

test('máximo tres rechazos reintentables y sin un cuarto despacho', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  await enqueue()
  for (const at of [
    reminderTime,
    '2026-10-28T14:05:00Z',
    '2026-10-28T14:20:00Z',
  ]) {
    const job = await claim(at)
    await finish(job!.dispatch_token, 'rejected_retryable', at)
  }
  expect(
    await scalar(db, 'SELECT status AS value FROM pos.credit_reminders'),
  ).toBe('failed')
  expect(await claim('2026-10-28T16:00:00Z')).toBeNull()
  expect(
    Number(
      await scalar(db, 'SELECT count(*) AS value FROM pos.reminder_attempts'),
    ),
  ).toBe(3)
})

test('filtros e historial muestran compras, abonos y autorizaciones con responsable', async () => {
  await authorize(db)
  await sale(db, '20')
  await receipt(db, '10')
  const history = await scalar<{
    purchases: { responsible: string }[]
    receipts: unknown[]
    limit_authorizations: unknown[]
  }>(db, 'SELECT pos.get_credit_history($1,$2) AS value', [
    ids.actor,
    ids.customer,
  ])
  expect(history?.purchases[0].responsible).toBe('Cajero de prueba')
  expect(history?.receipts).toHaveLength(2)
  expect(history?.limit_authorizations).toHaveLength(1)
  expect(
    await scalar(db, `SELECT pos.list_credits($1,$2,'paid') AS value`, [
      ids.actor,
      ids.customer,
    ]),
  ).toEqual([])
  expect(
    await scalar(
      db,
      `SELECT pos.list_credits($1,$2,'active','2026-11-01','2026-11-30') AS value`,
      [ids.actor, ids.customer],
    ),
  ).toEqual([])
  expect(
    await scalar(db, `SELECT pos.list_credits($1,$2) AS value`, [
      ids.actor,
      ids.otherCustomer,
    ]),
  ).toEqual([])
})

test('adaptador de simulación recorre cola y preflight sin red ni doble envío', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  const repository: ReminderRepository = {
    enqueue: async (at) => (await enqueue(at))!,
    claim: async (at) =>
      (await scalar<Dispatch | null>(
        db,
        'SELECT pos.claim_credit_reminder($1) AS value',
        [at],
      )) ?? null,
    preflight: async (token, at) =>
      (await scalar<Dispatch | null>(
        db,
        'SELECT pos.preflight_credit_reminder($1,$2) AS value',
        [token, at],
      ))!,
    finish: async (token, outcome, messageId, at) =>
      (await finish(token, outcome, at, messageId))!,
  }
  const transport = new MockWhatsAppTransport()
  const first = await runDryRunBatch(
    repository,
    transport,
    () => new Date(reminderTime),
  )
  expect(first.simulated).toBe(1)
  expect(transport.messages.size).toBe(1)
  expect(
    (await runDryRunBatch(repository, transport, () => new Date(reminderTime)))
      .simulated,
  ).toBe(0)
})

test('efectivo más transferencia más crédito mantienen separados caja, recaudo y cartera', async () => {
  await authorize(db)
  const methods = await db.query<{ id: string; code: string }>(
    'SELECT id,code FROM pos.payment_methods',
  )
  const cash = methods.rows.find((row) => row.code === 'cash')!.id
  const transfer = methods.rows.find((row) => row.code === 'transfer')!.id
  await scalar(
    db,
    `SELECT pos.confirm_sale($1,$2,$3,$4::jsonb,$5::jsonb,true,'three-way') AS value`,
    [
      ids.actor,
      ids.customer,
      ids.session,
      JSON.stringify([{ product_id: ids.product, quantity: 1 }]),
      JSON.stringify([
        { method_id: cash, amount: '30' },
        { method_id: transfer, amount: '20', reference: 'TR-1' },
      ]),
    ],
  )
  expect(await debt()).toBe(50)
  expect(
    Number(
      await scalar(db, 'SELECT sum(amount) AS value FROM pos.cash_entries'),
    ),
  ).toBe(30)
  expect(
    Number(await scalar(db, 'SELECT sum(amount) AS value FROM pos.payments')),
  ).toBe(50)
})

test('webhooks deduplicados y fuera de orden no retroceden una entrega leída', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  await enqueue()
  const job = await claim()
  await finish(job!.dispatch_token, 'accepted', reminderTime, 'mock-webhook')
  const event = (key: string, status: string, at: string) =>
    scalar(
      db,
      `SELECT pos.record_reminder_delivery('mock',$1,'mock-webhook',$2,$3) AS value`,
      [key, status, at],
    )
  expect(await event('read-1', 'read', '2026-10-28T14:02:00Z')).toBe('read')
  expect(await event('read-1', 'read', '2026-10-28T14:02:00Z')).toBe('read')
  expect(
    await event('delivered-late', 'delivered', '2026-10-28T14:01:00Z'),
  ).toBe('read')
  await expect(
    event('read-1', 'failed', '2026-10-28T14:02:00Z'),
  ).rejects.toThrow('DELIVERY_EVENT_CONFLICT')
  expect(
    Number(
      await scalar(
        db,
        'SELECT count(*) AS value FROM pos.reminder_delivery_events',
      ),
    ),
  ).toBe(2)
  expect(await claim('2026-10-28T15:00:00Z')).toBeNull()
})

test('regresar a un número anterior no recupera su consentimiento antiguo', async () => {
  await authorize(db)
  await sale(db)
  await contact(db)
  await staffQuery(db, `SELECT pos.set_whatsapp_contact($1,$2,'+573009876543')`, [
    ids.actor,
    ids.customer,
  ])
  await staffQuery(db, `SELECT pos.set_whatsapp_contact($1,$2,'+573001234567')`, [
    ids.actor,
    ids.customer,
  ])
  await db.query(`SELECT pos.verify_whatsapp_contact($1,'+573001234567')`, [
    ids.customer,
  ])
  await enqueue()
  expect((await claim())?.reason).toBe('no_consent')
})
