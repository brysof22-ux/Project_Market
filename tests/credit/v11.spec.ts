import { test, expect } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { createV11Database } from './v11-fixture'
import { createDatabase, resetDatabase, staffQuery, ids, scalar, authorize, sale } from './fixture'

let db: PGlite
let sequence = 0
const period = '11111111-1111-4111-8111-111111111111'
const admin = { sub: ids.otherActor, role: 'authenticated', exp: 4102444800 }
const cashier = { sub: ids.actor, role: 'authenticated', exp: 4102444800 }
const recent = () => ({ ...admin, session_id: '90000000-0000-4000-8000-000000000001',
  amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })
async function op(action: string, data: Record<string, unknown> = {}, options: { admin?: boolean; claims?: Record<string, unknown>; key?: string } = {}) {
  if (action === 'reset.preview') data = { expected_period: period, ...data }
  const r = await staffQuery<{ value: Record<string, unknown> }>(db,
    'SELECT public.cai_operations($1,$2::jsonb,$3) AS value',
    [action, JSON.stringify(data), options.key ?? `v11-${++sequence}`], options.claims ?? (options.admin ? admin : cashier))
  return r.rows[0].value
}
async function catalog(action: string, data: Record<string, unknown> = {}, asAdmin = false, key = `cat-${++sequence}`) {
  const r = await staffQuery<{ value: Record<string, unknown> }>(db,
    'SELECT public.cai_catalog($1,$2::jsonb,$3) AS value',
    [action, JSON.stringify(data), key], asAdmin ? admin : cashier)
  return r.rows[0].value
}
async function cashId() { return scalar<string>(db, "SELECT id AS value FROM pos.payment_methods WHERE code='cash'") }
async function sell(extra: Record<string, unknown> = {}, key?: string) {
  return op('sale.confirm', { expected_period: period, session_id: ids.session,
    expected_total: '100.00',
    finance: true, customer_name: 'Persona nueva', customer_phone: '3001234567',
    lines: [{ product_id: ids.product, quantity: 1 }], payments: [], ...extra }, { key })
}
test.beforeAll(async () => { db = await createV11Database() })
test.beforeEach(async () => { await resetDatabase(db, true) })
test.afterAll(async () => { await db.close() })

test('V1.1 bootstrap autoriza al cajero vender crédito y sólo su caja', async () => {
  const data = await op('bootstrap')
  expect(data.period_id).toBe(period)
  expect(data.permissions).toEqual({ credit: true, expenses: false })
  expect(data.session).toMatchObject({ id: ids.session, operator_id: ids.actor })
})

test('cajero vende crédito sin cupo previo; abono inicial no se duplica', async () => {
  const result = await sell({ payments: [{ method_id: await cashId(), amount: '25' }] }, 'inline')
  expect(result).toMatchObject({ total: '100.00', received: '25', financed: '75.00', due_on: null })
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.customers')).toBe(3)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.credit_receipts')).toBe(0)
  expect(await scalar(db, 'SELECT sum(amount)::text AS value FROM pos.cash_entries')).toBe('25.00')
  expect(await sell({ payments: [{ method_id: await cashId(), amount: '25' }] }, 'inline')).toEqual(result)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.sales')).toBe(1)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.customers')).toBe(3)
})

test('homónimos se mantienen separados; se reutiliza sólo UUID elegido', async () => {
  const a = await sell()
  const b = await sell({ customer_phone: '3007654321' })
  expect(await scalar(db, "SELECT count(DISTINCT customer_id)::integer AS value FROM pos.sales")).toBe(2)
  const first = await scalar<string>(db, 'SELECT customer_id AS value FROM pos.sales WHERE id=$1', [a.sale_id])
  await sell({ customer_id: first, customer_name: undefined, customer_phone: undefined })
  expect(await scalar(db, "SELECT count(DISTINCT customer_id)::integer AS value FROM pos.sales")).toBe(2)
  expect(a.charge_id).not.toBe(b.charge_id)
})

test('teléfono de crédito exige 7–15 dígitos y formatos permitidos, sin guardar clientes inválidos', async () => {
  for (const phone of ['abcde', '-------', '123456', '1234567890123456', '+57abc3001234567', '++573001234567']) {
    await expect(sell({ customer_phone: phone })).rejects.toThrow('CREDIT_IDENTITY_REQUIRED')
  }
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.customers')).toBe(2)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.sales')).toBe(0)
  for (const phone of ['1234567', '3001234567', '+57 (300) 123-4567']) {
    const result = await sell({ customer_phone: phone })
    expect(await scalar(db, 'SELECT phone AS value FROM pos.customers WHERE id=(SELECT customer_id FROM pos.sales WHERE id=$1)', [result.sale_id])).toBe(phone)
  }
})

test('selección de UUID existente con teléfono inválido se rechaza sin corregir ni mezclar su identidad', async () => {
  await db.query('UPDATE pos.customers SET phone=$1 WHERE id=$2', ['abcde', ids.customer])
  await expect(sell({ customer_id: ids.customer, customer_phone: '3001234567' })).rejects.toThrow('CREDIT_IDENTITY_REQUIRED')
  expect(await scalar(db, 'SELECT phone AS value FROM pos.customers WHERE id=$1', [ids.customer])).toBe('abcde')
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.credit_accounts')).toBe(0)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.sales')).toBe(0)
})

test('venta normal sin comprador registra Consumidor final y exige pago completo', async () => {
  await expect(sell({ finance: false })).rejects.toThrow('PAYMENTS_DO_NOT_MATCH')
  const r = await sell({ finance: false, customer_name: undefined, customer_phone: undefined,
    payments: [{ method_id: await cashId(), amount: '100' }] })
  expect(await scalar(db, 'SELECT buyer_name AS value FROM pos.sales WHERE id=$1', [r.sale_id])).toBe('Consumidor final')
  expect(await scalar(db, 'SELECT customer_id AS value FROM pos.sales WHERE id=$1', [r.sale_id])).toBeNull()
  expect(((await op('sales.list')).rows as { customer: string }[])[0].customer).toBe('Consumidor final')
  await sell({ finance: false, buyer_name: 'Comprador opcional',
    payments: [{ method_id: await cashId(), amount: '100' }] })
  expect(((await op('sales.list')).rows as { customer: string }[]).map((s) => s.customer)).toContain('Comprador opcional')
})

test('vencimiento opcional y filtros pendiente/vencida/pagada', async () => {
  await sell({ due_on: '2026-10-23' })
  expect((await op('debts.list', { status: 'pending' })).total).toBe(1)
  await db.exec(`CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE
    SET search_path=pg_catalog AS $$ SELECT timestamptz '2026-10-24 15:00:00+00' $$`)
  expect((await op('debts.list', { status: 'overdue' })).total).toBe(1)
  await expect(sell({ due_on: '2026-10-22' })).rejects.toThrow('INVALID_DUE_DATE')
})

test('precio cambiado con carrito pendiente no financia importes que el vendedor no confirmó', async () => {
  await db.exec(`UPDATE pos.products SET price=110,version=version+1 WHERE id='${ids.product}'`)
  await expect(sell()).rejects.toThrow('PRICE_CHANGED')
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.sales')).toBe(0)
  expect(await scalar(db, 'SELECT quantity AS value FROM pos.inventory_balances')).toBe(100)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.customers')).toBe(2)
  await sell({ expected_total: '110.00' })
  expect(await scalar(db, 'SELECT principal::text AS value FROM pos.credit_charges')).toBe('110.00')
})

test('abono dirigido no paga otras compras del mismo cliente y conserva historial', async () => {
  const first = await sell()
  const customer = await scalar<string>(db, 'SELECT customer_id AS value FROM pos.sales WHERE id=$1', [first.sale_id])
  const second = await sell({ customer_id: customer })
  const data = { charge_id: second.charge_id, expected_period: period, session_id: ids.session, amount: '100', method_id: await cashId() }
  const paid = await op('debt.receipt', data, { key: 'receipt' })
  expect(await op('debt.receipt', data, { key: 'receipt' })).toEqual(paid)
  expect(await scalar(db, 'SELECT outstanding::text AS value FROM pos.credit_charge_balances WHERE id=$1', [first.charge_id])).toBe('100.00')
  expect(await scalar(db, 'SELECT outstanding::text AS value FROM pos.credit_charge_balances WHERE id=$1', [second.charge_id])).toBe('0.00')
  const detail = await op('debt.detail', { charge_id: second.charge_id })
  expect(detail.products).toEqual([{ name: 'Producto', quantity: 1, unit_price: '100.00', total: '100.00' }])
  expect(detail.receipts).toHaveLength(1)
  expect((await op('debts.list', { status: 'paid' })).total).toBe(1)
  await expect(op('debt.receipt', data)).rejects.toThrow('AMOUNT_EXCEEDS_DEBT')
})

for (const action of ['cash.move', 'credit.limit', 'credit.history', 'credits.list', 'credit.receipt', 'sale.return', 'users.list', 'user.save', 'audit.list', 'settings.save', 'reset.preview', 'reset.confirm', 'periods.list', 'periods.detail']) {
  test(`SQL directo rechaza acción administrativa del cajero: ${action}`, async () => {
    await expect(op(action, { expected_period: period })).rejects.toThrow('FORBIDDEN')
  })
}
for (const action of ['inventory.history', 'product.save', 'inventory.adjust', 'supplier.save', 'customer.save', 'directories.list', 'media.attach']) {
  test(`SQL directo rechaza catálogo administrativo del cajero: ${action}`, async () => {
    await expect(catalog(action, { expected_period: period })).rejects.toThrow('FORBIDDEN')
  })
}

test('catálogo POS no expone costos ni proveedores y funciones internas carecen EXECUTE', async () => {
  const data = await catalog('products.list')
  const row = (data.rows as Record<string, unknown>[])[0]
  for (const field of ['purchase_price', 'supplier_id', 'category', 'barcode', 'sku']) expect(row).not.toHaveProperty(field)
  expect(await scalar(db, "SELECT has_function_privilege('authenticated','pos.confirm_sale(uuid,uuid,uuid,jsonb,jsonb,boolean,text)','EXECUTE') AS value")).toBe(false)
  await expect(staffQuery(db, 'SELECT public.cai_report()')).rejects.toThrow('FORBIDDEN')
})

test('producto simple genera SKU, audita stock y rechaza conteo obsoleto', async () => {
  const saved = await catalog('product.save', { name: 'Nuevo', price: '200', purchase_price: '100', quantity: 5, expected_stock: 0, minimum: 1, expected_period: period }, true)
  const p = await scalar<Record<string, unknown>>(db, 'SELECT to_jsonb(p) AS value FROM pos.products p WHERE id=$1', [saved.id])
  expect(p?.sku).toMatch(/^CAI-/)
  const edit = { id: saved.id, version: p?.version, name: 'Nuevo editado', price: '220', purchase_price: '100', minimum: 1,
    quantity: 6, expected_stock: 4, expected_period: period }
  await expect(catalog('product.save', edit, true)).rejects.toThrow('VERSION_CONFLICT')
  await catalog('product.save', { ...edit, expected_stock: 5 }, true)
  expect(await scalar(db, 'SELECT quantity AS value FROM pos.inventory_balances WHERE product_id=$1', [saved.id])).toBe(6)
  expect(await scalar(db, 'SELECT sku AS value FROM pos.products WHERE id=$1', [saved.id])).toBe(p?.sku)
})

test('Supervisor se conserva, se bloquea y sólo admin puede reclasificarlo', async () => {
  await db.exec(`UPDATE pos.profiles SET role='supervisor' WHERE id='${ids.actor}'`)
  await expect(op('bootstrap')).rejects.toThrow('ROLE_RECLASSIFICATION_REQUIRED')
  await op('user.save', { id: ids.actor, display_name: 'Reclasificado', role: 'cashier', active: true, expected_period: period }, { admin: true })
  expect((await op('bootstrap')).permissions).toEqual({ credit: true, expenses: false })
  await expect(op('user.save', { id: ids.actor, display_name: 'Otro', role: 'supervisor', expected_period: period }, { admin: true })).rejects.toThrow('INVALID_ROLE')
})

test('todos los mutantes exigen período y rechazan pestañas antiguas', async () => {
  await expect(op('cash.close', { session_id: ids.session, counted: '50' })).rejects.toThrow('PERIOD_REQUIRED')
  await expect(sell({ expected_period: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow('PERIOD_CHANGED')
})

test('reinicio exige autenticación real reciente, no iat ni token_refresh', async () => {
  await expect(op('reset.preview', {}, { admin: true })).rejects.toThrow('RECENT_AUTH_REQUIRED')
  await expect(op('reset.preview', {}, { claims: { ...recent(), amr: [{ method: 'token_refresh', timestamp: Math.floor(Date.now() / 1000) }] } })).rejects.toThrow('RECENT_AUTH_REQUIRED')
  await expect(op('reset.preview', {}, { claims: { ...recent(), amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 301 }] } })).rejects.toThrow('RECENT_AUTH_REQUIRED')
})

test('reinicio rechaza caja abierta y conserva compuerta operativa después del error', async () => {
  const claims = recent()
  const preview = await op('reset.preview', {}, { claims })
  await expect(op('reset.confirm', { expected_period: period, intent_id: preview.intent_id, confirmation: 'REINICIAR OPERACION', reason: 'Nuevo período' }, { claims })).rejects.toThrow('OPEN_CASH_SESSIONS')
  expect((await op('bootstrap')).period_id).toBe(period)
  await sell()
})

test('reinicio archiva sin borrado, conserva perfiles/productos/precios y no duplica ejecución', async () => {
  const s = await sell({ payments: [{ method_id: await cashId(), amount: '20' }] })
  await op('cash.close', { session_id: ids.session, counted: '70', expected_period: period })
  const claims = recent()
  const preview = await op('reset.preview', {}, { claims })
  const command = { expected_period: period, intent_id: preview.intent_id, confirmation: 'REINICIAR OPERACION', reason: 'Inicio de período operativo' }
  const result = await op('reset.confirm', command, { claims, key: 'reset' })
  expect(result.previous_period_id).toBe(period)
  expect(await op('reset.confirm', command, { claims, key: 'reset' })).toEqual(result)
  expect((await op('bootstrap')).period_id).toBe(result.period_id)
  expect((await op('debts.list')).total).toBe(0)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.sales')).toBe(1)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.credit_charges')).toBe(1)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.products')).toBe(1)
  expect(await scalar(db, 'SELECT count(*)::integer AS value FROM pos.profiles')).toBe(2)
  expect(await scalar(db, 'SELECT quantity AS value FROM pos.inventory_balances WHERE operating_period_id=$1', [result.period_id])).toBe(0)
  expect(await scalar(db, 'SELECT quantity AS value FROM pos.inventory_balances WHERE operating_period_id=$1', [period])).toBe(99)
  const archive = await op('periods.detail', { period_id: period }, { admin: true })
  expect(archive.debts).toHaveLength(1)
  expect((archive.debts as Record<string, unknown>[])[0].outstanding).toBe('80.00')
  // FK checks normally bypass RLS. The period trigger must still reject a new
  // active payment linked to an archived sale, even for a trusted SQL writer.
  await expect(db.query(`INSERT INTO pos.payments(sale_id,method_id,amount,affects_cash_snapshot)
    VALUES($1,$2,1,false)`, [s.sale_id, await cashId()])).rejects.toThrow('CROSS_PERIOD_REFERENCE')
  await expect(op('debt.receipt', { charge_id: s.charge_id, expected_period: result.period_id, amount: '1', session_id: ids.session, method_id: await cashId() })).rejects.toThrow('DEBT_NOT_FOUND')
  await expect(op('sale.return', { sale_id: s.sale_id, expected_period: result.period_id, session_id: ids.session, reason: 'Devolución histórica rechazada' }, { admin: true })).rejects.toThrow('SALE_NOT_FOUND')
  expect(await scalar(db, "SELECT has_schema_privilege('pos_owner','pos','CREATE') AS value")).toBe(false)
  expect(await scalar(db, "SELECT has_schema_privilege('pos_owner','public','CREATE') AS value")).toBe(false)
})

test('migración V1→V1.1 preserva cada columna y fila histórica y sus propietarios', async () => {
  const original = await createDatabase()
  try {
    await resetDatabase(original)
    await authorize(original)
    await sale(original, '25')
    const tables = await original.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname='pos' ORDER BY tablename")
    const snapshots: { table: string; columns: string; data: unknown }[] = []
    for (const table of tables.rows) {
      const cols = await original.query<{ name: string }>(`SELECT quote_ident(column_name) AS name FROM information_schema.columns
        WHERE table_schema='pos' AND table_name=$1 ORDER BY ordinal_position`, [table.name])
      const columns = cols.rows.map((c) => c.name).join(',')
      const before = await original.query(`SELECT ${columns} FROM pos.${table.name} ORDER BY ${columns}`)
      snapshots.push({ table: table.name, columns, data: before.rows })
    }
    const due = await scalar(original, 'SELECT due_on::text AS value FROM pos.credit_charges')
    const bridgeSql = "SELECT proowner::regrole::text AS owner,proacl::text AS acl,md5(pg_get_functiondef(oid)) AS definition FROM pg_proc WHERE oid='pos.current_profile_auth_uid()'::regprocedure"
    const bridgeBefore = (await original.query(bridgeSql)).rows
    await original.exec('SET ROLE credit_migrator')
    await original.exec(await readFile('supabase/migrations/20261025000900_v11_periods_permissions.sql', 'utf8'))
    await original.exec('RESET ROLE')
    expect((await original.query(bridgeSql)).rows).toEqual(bridgeBefore)
    for (const snap of snapshots) {
      const after = await original.query(`SELECT ${snap.columns} FROM pos.${snap.table} ORDER BY ${snap.columns}`)
      expect(after.rows, snap.table).toEqual(snap.data)
    }
    expect(await scalar(original, 'SELECT due_on::text AS value FROM pos.credit_charges')).toBe(due)
    expect(await scalar(original, `SELECT count(*)::integer AS value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='pos' AND c.relkind='r' AND pg_get_userbyid(c.relowner)<>'pos_owner'`)).toBe(0)
    expect(await scalar(original, `SELECT count(*)::integer AS value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='pos' AND c.relkind='r' AND NOT c.relrowsecurity`)).toBe(0)
  } finally { await original.close() }
})

test('009 se detiene antes de cambiar objetos si el puente 005 tiene EXECUTE adicional', async () => {
  const original = await createDatabase()
  try {
    await original.exec('GRANT EXECUTE ON FUNCTION pos.current_profile_auth_uid() TO anon; SET ROLE credit_migrator')
    await expect(original.exec(await readFile('supabase/migrations/20261025000900_v11_periods_permissions.sql', 'utf8'))).rejects.toThrow('UNSAFE_AUTH_BRIDGE_ACL')
    await original.exec('ROLLBACK; RESET ROLE')
    expect(await scalar(original, "SELECT to_regclass('pos.operating_periods')::text AS value")).toBeNull()
    expect(await scalar(original, "SELECT has_schema_privilege('pos_owner','public','CREATE') AS value")).toBe(false)
  } finally { await original.close() }
})

test('imagen se vincula mediante CAS, limita metadatos y persiste al cambiar período', async () => {
  const imageId = '55555555-5555-4555-8555-555555555555'
  const payload = { product_id: ids.product, image_id: imageId,
    object_key: `products/${ids.product}/${imageId}`, mime: 'image/png', size: 1000, width: 100, height: 100,
    etag: 'fake-etag', expected_image_id: null, expected_period: period }
  expect(await catalog('media.attach', payload, true, 'image')).toEqual({ image_id: imageId })
  expect(await catalog('media.attach', payload, true, 'image')).toEqual({ image_id: imageId })
  expect(await catalog('media.read', { product_id: ids.product })).toMatchObject({ image_id: imageId, object_key: payload.object_key })
  await expect(catalog('media.attach', { ...payload, image_id: '66666666-6666-4666-8666-666666666666' }, true)).rejects.toThrow('VERSION_CONFLICT')
  await op('cash.close', { expected_period: period, session_id: ids.session, counted: '50' })
  const claims = recent()
  const preview = await op('reset.preview', {}, { claims })
  await op('reset.confirm', { expected_period: period, intent_id: preview.intent_id, confirmation: 'REINICIAR OPERACION', reason: 'Conservar fotos' }, { claims })
  expect(await catalog('media.read', { product_id: ids.product })).toMatchObject({ image_id: imageId })
})

test('confirmación de reinicio rechaza intención ajena, cambios posteriores y texto incorrecto', async () => {
  await op('cash.close', { expected_period: period, session_id: ids.session, counted: '50' })
  const claims = recent()
  const preview = await op('reset.preview', {}, { claims })
  const command = { expected_period: period, intent_id: preview.intent_id, confirmation: 'REINICIAR OPERACION', reason: 'Prueba segura' }
  await expect(op('reset.confirm', { ...command, confirmation: 'sí' }, { claims })).rejects.toThrow('RESET_CONFIRMATION_REQUIRED')
  await expect(op('reset.confirm', command, { claims: { ...claims, session_id: '90000000-0000-4000-8000-000000000002' } })).rejects.toThrow('RESET_INTENT_INVALID')
  await catalog('inventory.adjust', { product_id: ids.product, delta: 1, reason: 'Cambio posterior', expected_period: period }, true)
  await expect(op('reset.confirm', command, { claims })).rejects.toThrow('RESET_PREVIEW_CHANGED')
  expect((await op('bootstrap')).period_id).toBe(period)
})

test('reporte del administrador sólo incluye el período activo después del reinicio', async () => {
  await sell({ payments: [{ method_id: await cashId(), amount: '10' }] })
  await op('cash.close', { expected_period: period, session_id: ids.session, counted: '60' })
  const claims = recent()
  const preview = await op('reset.preview', {}, { claims })
  await op('reset.confirm', { expected_period: period, intent_id: preview.intent_id, confirmation: 'REINICIAR OPERACION', reason: 'Período separado' }, { claims })
  const report = await staffQuery<{ value: Record<string, unknown> }>(db, 'SELECT public.cai_report() AS value', [], admin)
  expect(report.rows[0].value).toMatchObject({ gross_sales: '0', outstanding: '0', transactions: 0 })
})

test('una devolución conserva abonos recibidos y declara compensación sin fingir pago total', async () => {
  const s = await sell({ payments: [{ method_id: await cashId(), amount: '25' }] })
  await op('sale.return', { expected_period: period, sale_id: s.sale_id, session_id: ids.session, method_id: await cashId(), reason: 'Devolución autorizada' }, { admin: true })
  const detail = await op('debt.detail', { charge_id: s.charge_id })
  expect(detail).toMatchObject({ returned: true, paid: '25.00', outstanding: '0.00', refund_amount: '25.00', return_credit_reduction: '75.00' })
})
