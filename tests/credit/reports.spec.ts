import { test, expect } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase, resetDatabase, staffQuery, ids, sale, receipt, authorize } from './fixture'

let db: PGlite
test.beforeAll(async () => { db = await createDatabase() })
test.beforeEach(async () => { await resetDatabase(db) })
test.afterAll(async () => { await db.close() })
async function report(cashier = false, data = {}) {
  const result = await staffQuery<{ value: Record<string, unknown> }>(db,'SELECT public.cai_report($1::jsonb) AS value',[JSON.stringify(data)],
    { sub: cashier ? ids.actor : ids.otherActor, role:'authenticated',exp:4102444800 })
  return result.rows[0].value
}
test('sin registros: ceros reales y serie vacía de actividad, no cifras de ejemplo', async () => {
  const data = await report()
  expect(data).toMatchObject({gross_sales:'0',net_sales:'0',collections:'0',transactions:0,products:1})
  expect(data.series).toHaveLength(7)
  expect(data.top_products).toEqual([])
})
test('venta, recaudo inicial y abono no duplican ingresos de venta', async () => {
  await db.query('UPDATE pos.products SET purchase_price=40')
  await authorize(db)
  await sale(db,'20')
  await receipt(db,'30')
  const data = await report()
  expect(data).toMatchObject({gross_sales:'100.00',net_sales:'100.00',collections:'50.00',outstanding:'50.00',gross_profit:'60.00'})
  expect(data.methods).toEqual([expect.objectContaining({code:'cash',total:'50.00'})])
  await db.query("UPDATE pos.products SET purchase_price=90,category='Nueva categoría'")
  const historical = await report()
  expect(historical.gross_profit).toBe('60.00')
  expect(historical.categories).toEqual([expect.objectContaining({category:'Sin categoría',gross_profit:'60.00'})])
})
test('sin costo conocido no inventa utilidad; cajero no recibe cartera ni costos/gastos globales', async () => {
  await sale(db,'100',1,'noncredit',false)
  expect((await report()).gross_profit).toBeNull()
  expect(await report(true)).toMatchObject({limited:true,gross_profit:null,expenses:null,outstanding:null})
})
test('períodos inválidos rechazados', async () => {
  await expect(report(false,{unused:'x'.repeat(33000)})).rejects.toThrow('INVALID_INPUT')
  await expect(report(false,{from:'2026-10-24',to:'2026-10-23'})).rejects.toThrow('INVALID_PERIOD')
  await expect(report(false,{from:'2020-01-01',to:'2026-10-23'})).rejects.toThrow('INVALID_PERIOD')
})
