import { test, expect } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase, resetDatabase, staffQuery, ids, scalar } from './fixture'

let db: PGlite
let sequence = 0
const admin = { sub: ids.otherActor, role: 'authenticated', exp: 4102444800 }
async function operation(action: string, data: unknown = {}, key = `op-${++sequence}`, cashier = false) {
  const result = await staffQuery<{ result: Record<string, unknown> }>(db,
    'SELECT public.cai_operations($1,$2::jsonb,$3) AS result',[action,JSON.stringify(data),key],cashier ? undefined : admin)
  return result.rows[0].result
}
test.beforeAll(async () => { db = await createDatabase() })
test.beforeEach(async () => { await resetDatabase(db) })
test.afterAll(async () => { await db.close() })
async function cashMethod() { return scalar<string>(db,"SELECT id AS value FROM pos.payment_methods WHERE code='cash'") }
async function confirm(finance = false, paid = '100') {
  return operation('sale.confirm',{ session_id: ids.session, customer_id: ids.customer, finance,
    lines: [{ product_id: ids.product, quantity: 1, unit_price: '0.01' }],
    payments: paid === '0' ? [] : [{ method_id: await cashMethod(), amount: paid }] })
}

test('venta real ignora precio/actor del cliente, registra pago, inventario y auditoría', async () => {
  const sale = await confirm()
  expect(sale.total).toBe('100.00')
  expect(await scalar(db,'SELECT quantity AS value FROM pos.inventory_balances WHERE product_id=$1',[ids.product])).toBe(99)
  expect(await scalar(db,'SELECT created_by AS value FROM pos.sales WHERE id=$1',[sale.sale_id])).toBe(ids.otherActor)
  expect(await scalar(db,'SELECT sum(amount)::text AS value FROM pos.cash_entries')).toBe('100.00')
})

test('caja: gasto, arqueo y cierre con diferencia persistente; caja cerrada rechaza ventas', async () => {
  await operation('cash.move',{session_id: ids.session,kind:'expense',amount:'20',reason:'Gasto operativo'},'expense')
  await operation('cash.move',{session_id: ids.session,kind:'expense',amount:'20',reason:'Gasto operativo'},'expense')
  const close = await operation('cash.close',{session_id: ids.session,counted:'29'})
  expect(close).toMatchObject({expected:'30.00',counted:'29',difference:'-1.00'})
  await expect(confirm()).rejects.toThrow('CASH_SESSION_NOT_OPEN')
  expect(await scalar(db,'SELECT count(*)::integer AS value FROM pos.sales')).toBe(0)
})

test('apertura única e idempotente, saldo de apertura no se duplica como ingreso de venta', async () => {
  const data = {register_code:'SECOND',opening_float:'100'}
  const first = await operation('cash.open',data,'opening')
  expect(await operation('cash.open',data,'opening')).toEqual(first)
  const bootstrap = await operation('bootstrap')
  expect(bootstrap.session).toMatchObject({opening_float:100,expected:100})
  expect(await scalar(db,'SELECT count(*)::integer AS value FROM pos.cash_entries')).toBe(0)
})

test('devolución compensatoria completa, idempotente, repone stock y conserva venta original', async () => {
  const sale = await confirm()
  const data = { sale_id: sale.sale_id, session_id: ids.session, method_id: await cashMethod(), reason: 'Devolución autorizada' }
  const result = await operation('sale.return',data,'return')
  expect(result).toMatchObject({refund:'100.00',credit_reduction:'0'})
  expect(await operation('sale.return',data,'return')).toEqual(result)
  await expect(operation('sale.return',data,'another')).rejects.toThrow('SALE_ALREADY_RETURNED')
  expect(await scalar(db,'SELECT quantity AS value FROM pos.inventory_balances WHERE product_id=$1',[ids.product])).toBe(100)
  expect(await scalar(db,'SELECT total::text AS value FROM pos.sales')).toBe('100.00')
  expect(await scalar(db,"SELECT amount::text AS value FROM pos.cash_adjustments WHERE kind='refund'")).toBe('-100.00')
})

test('devolución de crédito con abono reintegra solo lo pagado y extingue saldo restante', async () => {
  await operation('credit.limit',{customer_id:ids.customer,amount:'500',reason:'Cupo aprobado'})
  const sale = await confirm(true,'20')
  await operation('credit.receipt',{customer_id:ids.customer,session_id:ids.session,amount:'30',method_id:await cashMethod()})
  const result = await operation('sale.return',{sale_id:sale.sale_id,session_id:ids.session,method_id:await cashMethod(),reason:'Entrega devuelta'})
  expect(result).toMatchObject({refund:'50.00',credit_reduction:'50.00'})
  expect(await scalar(db,'SELECT outstanding::text AS value FROM pos.credit_account_balances')).toBe('0.00')
  await expect(operation('credit.receipt',{customer_id:ids.customer,session_id:ids.session,amount:'1',method_id:await cashMethod()})).rejects.toThrow('AMOUNT_EXCEEDS_DEBT')
})

test('permisos por operación: cajero no devuelve, modifica perfiles, límites ni gastos sin autorización', async () => {
  await expect(operation('bootstrap',{unused:'x'.repeat(33000)})).rejects.toThrow('INVALID_INPUT')
  for (const action of ['sale.return','user.save','credit.limit','cash.move','credit.receipt']) {
    await expect(operation(action,{},'denied',true)).rejects.toThrow('FORBIDDEN')
  }
  await expect(operation('sale.confirm',{ finance: true },'denied',true)).rejects.toThrow('FORBIDDEN')
  await expect(operation('user.save',{id:ids.otherActor,display_name:'Admin',role:'cashier',active:false})).rejects.toThrow('CANNOT_DISABLE_SELF')
  expect(await scalar(db,'SELECT role AS value FROM pos.profiles WHERE id=$1',[ids.otherActor])).toBe('admin')
})

test('gasto mayor a efectivo disponible no deja movimiento parcial', async () => {
  await expect(operation('cash.move',{session_id:ids.session,kind:'expense',amount:'51',reason:'No debe guardar'})).rejects.toThrow('INSUFFICIENT_CASH')
  expect(await scalar(db,'SELECT count(*)::integer AS value FROM pos.cash_adjustments')).toBe(0)
})

test('historial de crédito conserva paginación y una devolución netea ventas/recaudos', async () => {
  await operation('credit.limit',{customer_id:ids.customer,amount:'500',reason:'Cupo'})
  const sale = await confirm(true,'20')
  const history = await operation('credit.history',{customer_id:ids.customer,limit:20,offset:0})
  expect(history.purchases).toHaveLength(1)
  expect(history.pagination).toMatchObject({offset:0,limit_per_history:20})
  await operation('sale.return',{sale_id:sale.sale_id,session_id:ids.session,method_id:await cashMethod(),reason:'Devolución completa'})
  expect((await operation('credit.history',{customer_id:ids.customer})).returns).toEqual([
    expect.objectContaining({credit_reduction:'80.00',refund_amount:'20.00',reason:'Devolución completa'}),
  ])
  const report = await staffQuery<{value:Record<string,unknown>}>(db,'SELECT public.cai_report() AS value',[],admin)
  expect(report.rows[0].value).toMatchObject({gross_sales:'100.00',returns:'100.00',net_sales:'0.00',collections:'0.00',outstanding:'0.00'})
})

test('fallo tardío de venta por pago incorrecto revierte existencias, pagos y auditoría', async () => {
  await expect(confirm(false,'99')).rejects.toThrow('PAYMENTS_DO_NOT_MATCH')
  expect(await scalar(db,'SELECT count(*)::integer AS value FROM pos.sales')).toBe(0)
  expect(await scalar(db,'SELECT count(*)::integer AS value FROM pos.payments')).toBe(0)
  expect(await scalar(db,'SELECT quantity AS value FROM pos.inventory_balances WHERE product_id=$1',[ids.product])).toBe(100)
})
