import { test, expect } from '@playwright/test'
import type { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { createV11Database } from './v11-fixture'
import { createV12Database } from './v12-fixture'
import { resetDatabase, staffQuery, scalar, ids } from './fixture'
let db: PGlite
const admin = { sub: ids.otherActor, role: 'authenticated', exp: 4102444800 }
const cashier = { sub: ids.actor, role: 'authenticated', exp: 4102444800 }
const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64)
async function qr(action: string, data = {}, asAdmin = true) {
  return (await staffQuery<{ value: unknown }>(db, 'SELECT public.cai_catalog($1,$2::jsonb,null) AS value', [action, JSON.stringify(data)], asAdmin ? admin : cashier)).rows[0].value
}
const image = (code: string, id = hash, expected: string | null = null) => ({ code, image_id: id, expected_image_id: expected, object_key: `transfer-qr/${id}`, mime: 'image/png', size: 100, width: 512, height: 512 })
test.beforeAll(async () => { db = await createV12Database() })
test.beforeEach(async () => {
 await resetDatabase(db, true)
 await db.exec("INSERT INTO pos.transfer_qr(code,name) VALUES('nequi','Nequi'),('breb','Llaves Bre-B') ON CONFLICT DO NOTHING; INSERT INTO pos.payment_methods(code,name,active,affects_cash,requires_reference) VALUES('card','Tarjeta',false,false,true) ON CONFLICT(code) DO NOTHING; UPDATE pos.payment_methods SET active=false WHERE code='card'; UPDATE pos.payment_methods SET requires_reference=false WHERE code='transfer'; UPDATE pos.transfer_qr SET image_id=null; DELETE FROM pos.transfer_qr_media;")
})
test.afterAll(async () => { await db.close() })
test('admin reemplaza cada QR independientemente, conserva nombres y deduplica', async () => {
 await qr('qr.attach', image('nequi')); await qr('qr.attach', image('breb'))
 expect(await scalar(db,'SELECT count(*)::integer AS value FROM pos.transfer_qr_media')).toBe(1)
 await qr('qr.attach', image('nequi',otherHash,hash))
 expect(await qr('qr.list', {}, false)).toEqual([{code:'nequi',name:'Nequi',image_id:otherHash},{code:'breb',name:'Llaves Bre-B',image_id:hash}])
 await expect(qr('qr.attach',image('nequi',hash))).rejects.toThrow('IMAGE_CONFLICT')
})
test('cajero puede leer pero no reemplazar ni escribir tablas; supervisor bloqueado', async () => {
 await qr('qr.attach',image('nequi'))
 expect(await qr('qr.read',{code:'nequi'},false)).toMatchObject({image_id:hash})
 await expect(qr('qr.attach',image('nequi',otherHash,hash),false)).rejects.toThrow('FORBIDDEN')
 await expect(staffQuery(db,"UPDATE pos.transfer_qr SET image_id=null",[],cashier)).rejects.toThrow('permission denied')
 await db.query("UPDATE pos.profiles SET role='supervisor' WHERE id=$1",[ids.actor])
 await expect(qr('qr.list',{},false)).rejects.toThrow('ROLE_RECLASSIFICATION_REQUIRED')
})
test('transferencia sin referencia exige verificación manual y QR vigente, no afecta efectivo; idempotencia y tarjeta', async () => {
 await qr('qr.attach',image('nequi'))
 const transfer = await scalar<string>(db,"SELECT id AS value FROM pos.payment_methods WHERE code='transfer'")
 const card = await scalar<string>(db,"SELECT id AS value FROM pos.payment_methods WHERE code='card'")
 const sell = (payment: object, key = 'v12-sale') => staffQuery<{value:unknown}>(db,'SELECT public.cai_operations($1,$2::jsonb,$3) AS value',['sale.confirm',JSON.stringify({expected_period:'11111111-1111-4111-8111-111111111111',session_id:ids.session,expected_total:'100.00',finance:false,lines:[{product_id:ids.product,quantity:1}],payments:[{method_id:transfer,amount:'100',qr_code:'nequi',qr_image_id:hash,...payment}]}),key],cashier)
 await expect(sell({})).rejects.toThrow('TRANSFER_CONFIRMATION_REQUIRED')
 await expect(sell({manually_verified:true,qr_image_id:otherHash})).rejects.toThrow('IMAGE_CONFLICT')
 const first = await sell({manually_verified:true})
 expect(await sell({manually_verified:true})).toEqual(first)
 expect(await scalar(db,'SELECT count(*)::integer AS value FROM pos.sales')).toBe(1)
 expect(await scalar(db,'SELECT sum(amount)::text AS value FROM pos.cash_entries')).toBe(null)
 expect(await scalar(db,'SELECT reference AS value FROM pos.payments')).toBe(null)
 expect(await scalar(db,'SELECT transfer_qr_image_id AS value FROM pos.payments')).toBe(hash)
 await expect(sell({method_id:card},'card')).rejects.toThrow('INVALID_PAYMENT_METHOD')
})
test('producto conserva categoría compatible al crear y editar sin campo visual', async () => {
 const cat = (data: object,key:string) => staffQuery(db,'SELECT public.cai_catalog($1,$2::jsonb,$3)',['product.save',JSON.stringify({expected_period:'11111111-1111-4111-8111-111111111111',name:'Producto V1.2',price:'100',minimum:0,quantity:8,expected_stock:0,active:true,...data}),key],admin)
 await cat({},'create')
 const product=(await db.query<{id:string;version:number;category:string}>("SELECT id,version,category FROM pos.products WHERE name='Producto V1.2'")).rows[0]
 await cat({id:product.id,version:product.version,expected_stock:8,quantity:8},'edit')
 expect(await scalar(db,'SELECT category AS value FROM pos.products WHERE id=$1',[product.id])).toBe(product.category)
})

test('actualización V1.1 conserva ventas, pagos con tarjeta, referencias y categorías históricas',async()=>{
 const legacy=await createV11Database()
 try {
  await resetDatabase(legacy,true)
  await legacy.exec("INSERT INTO pos.payment_methods(code,name,affects_cash,requires_reference) VALUES('card','Tarjeta',false,true)")
  for(const code of ['card','transfer']) {
   const id=await scalar<string>(legacy,'SELECT id AS value FROM pos.payment_methods WHERE code=$1',[code])
   await staffQuery(legacy,'SELECT public.cai_operations($1,$2::jsonb,$3)',['sale.confirm',JSON.stringify({expected_period:'11111111-1111-4111-8111-111111111111',session_id:ids.session,expected_total:'100',finance:false,lines:[{product_id:ids.product,quantity:1}],payments:[{method_id:id,amount:'100',reference:'REFERENCIA-HISTÓRICA'}]}),`legacy-${code}`],cashier)
  }
  const query='SELECT id,sale_id,method_id,amount,reference,affects_cash_snapshot FROM pos.payments ORDER BY id'
  const before=(await legacy.query(query)).rows
  await legacy.exec('SET ROLE credit_migrator')
  await legacy.exec(await readFile('supabase/migrations/20261026001000_v12_transfer_qr.sql','utf8'))
  await legacy.exec('RESET ROLE')
  expect((await legacy.query(query)).rows).toEqual(before)
  expect(await scalar(legacy,'SELECT count(*)::integer AS value FROM pos.sales')).toBe(2)
  expect(await scalar(legacy,"SELECT requires_reference AS value FROM pos.payment_methods WHERE code='transfer'")).toBe(false)
  expect(await scalar(legacy,"SELECT active AS value FROM pos.payment_methods WHERE code='card'")).toBe(false)
 } finally { await legacy.close() }
})
