import { test, expect } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { createDatabase, resetDatabase, staffQuery, ids, scalar } from './fixture'

let db: PGlite
let key = 0
const admin = { sub: ids.otherActor, role: 'authenticated', exp: 4102444800 }
async function catalog(action: string, data: unknown = {}, operationKey = `catalog-${++key}`, cashier = false) {
  const response = await staffQuery<{ result: Record<string, unknown> }>(db,
    'SELECT public.cai_catalog($1,$2::jsonb,$3) AS result', [action, JSON.stringify(data), operationKey], cashier ? undefined : admin)
  return response.rows[0].result
}
test.beforeAll(async () => { db = await createDatabase() })
test.beforeEach(async () => { await resetDatabase(db) })
test.afterAll(async () => { await db.close() })

test('catálogo persiste productos, costos/categoría/proveedor y stock inicia en cero', async () => {
  const supplier = await catalog('supplier.save', { name: 'Proveedor', email: 'proveedor@example.test' })
  const product = await catalog('product.save', { name: 'Nuevo', sku: 'NEW', price: '150000', purchase_price: '90000',
    category: 'Bebidas', minimum: 2, barcode: '1234', supplier_id: supplier.id, stock: 999 })
  const page = await catalog('products.list', { search: 'NEW' })
  expect(page.total).toBe(1)
  expect(page.rows).toEqual([expect.objectContaining({ id: product.id, stock: 0, price: '150000.00',
    purchase_price: '90000.00', category: 'Bebidas', supplier_id: supplier.id })])
})

test('entrada/salida auditable e idempotente, nunca stock negativo ni cambios parciales', async () => {
  const input = { product_id: ids.product, delta: 20, reason: 'Compra al proveedor' }
  await catalog('inventory.adjust', input, 'same')
  await catalog('inventory.adjust', input, 'same')
  expect(await scalar(db,'SELECT quantity AS value FROM pos.inventory_balances WHERE product_id=$1',[ids.product])).toBe(120)
  expect(await scalar(db,'SELECT count(*)::integer AS value FROM pos.inventory_adjustments')).toBe(1)
  await expect(catalog('inventory.adjust', { ...input, delta: -121 })).rejects.toThrow('INSUFFICIENT_STOCK')
  await expect(catalog('inventory.adjust', { ...input, delta: 1.5 })).rejects.toThrow('INVALID_INPUT')
  await expect(catalog('inventory.adjust', { ...input, delta: 1 }, 'same')).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  expect(await scalar(db,'SELECT quantity AS value FROM pos.inventory_balances WHERE product_id=$1',[ids.product])).toBe(120)
})

test('cajero consulta sin costos, no modifica productos/proveedores/existencias', async () => {
  await db.query('UPDATE pos.products SET purchase_price=50 WHERE id=$1',[ids.product])
  const page = await catalog('products.list', {}, 'read', true)
  expect(page.rows).toEqual([expect.objectContaining({ purchase_price: null })])
  for (const action of ['product.save', 'inventory.adjust', 'supplier.save']) {
    await expect(catalog(action, {}, 'denied', true)).rejects.toThrow('FORBIDDEN')
  }
  const customer = await catalog('customer.save', { name: 'Cliente nuevo', phone: '3000000000' }, 'customer', true)
  expect(customer.id).toEqual(expect.any(String))
})

test('edición concurrente optimista y desactivación lógica', async () => {
  const input = { id: ids.product, version: 1, sku: 'TEST', name: 'Editado', price: '200', active: false }
  await catalog('product.save', input)
  await expect(catalog('product.save', { ...input, name: 'Obsoleto' })).rejects.toThrow('VERSION_CONFLICT')
  expect((await catalog('products.list', {}, 'read', true)).total).toBe(0)
  expect((await catalog('products.list')).rows).toEqual([expect.objectContaining({ name: 'Editado', version: 2, active: false })])
})

test('validaciones y paginación, no SQL arbitrario ni actor de cliente', async () => {
  await expect(catalog('products.list',{ limit: 101 })).rejects.toThrow('INVALID_PAGINATION')
  await expect(catalog('products.list',{unused:'x'.repeat(33000)})).rejects.toThrow('INVALID_INPUT')
  await expect(catalog('execute.sql',{ sql: 'DROP TABLE pos.products' })).rejects.toThrow('UNKNOWN_OPERATION')
  await expect(catalog('customer.save',{ name: ' ', email: 'bad' })).rejects.toThrow('INVALID_INPUT')
  await expect(catalog('customer.save',{name:{unexpected:'object'}})).rejects.toThrow('INVALID_INPUT')
  await catalog('inventory.adjust',{ product_id: ids.product, delta: 1, reason: 'Conteo', actor: ids.actor })
  expect(await scalar(db,"SELECT actor_id AS value FROM pos.audit_events WHERE action='inventory.adjust'")).toBe(ids.otherActor)
})

test('ACL mínimas, propietario/RLS y permisos temporales revocados', async () => {
  for (const role of ['anon','service_role','pos_app','pos_scheduler']) {
    expect(await scalar(db,"SELECT has_function_privilege($1,'public.cai_catalog(text,jsonb,text)','EXECUTE') AS value",[role])).toBe(false)
  }
  expect(await scalar(db,"SELECT has_schema_privilege('pos_owner','public','CREATE') AS value")).toBe(false)
  expect(await scalar(db,"SELECT has_schema_privilege('pos_owner','pos','CREATE') AS value")).toBe(false)
  expect(await scalar(db,"SELECT count(*)::integer AS value FROM pg_tables WHERE schemaname='pos' AND (tableowner<>'pos_owner' OR NOT rowsecurity)")).toBe(0)
  await expect(staffQuery(db,'SELECT * FROM pos.suppliers')).rejects.toThrow('permission denied')
  await db.exec(await readFile('supabase/checks/v1_preflight.sql','utf8'))
})
