import {readFile} from 'node:fs/promises'
import {createV12Database} from './v12-fixture'
import { test,expect } from '@playwright/test'
import { createV13Database } from './v13-fixture'
import { resetDatabase,staffQuery,ids,scalar } from './fixture'
import type {PGlite} from '@electric-sql/pglite'
let db:PGlite
let serial=0
const admin={sub:ids.otherActor,role:'authenticated',exp:4102444800,session_id:'90000000-0000-4000-8000-000000000001',amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]}
const period='11111111-1111-4111-8111-111111111111'
const op=async(action:string,data:object={},key=`test-${++serial}`)=>(await staffQuery<{value:any}>(db,'SELECT public.cai_operations($1,$2::jsonb,$3) value',[action,JSON.stringify({expected_period:period,...data}),key],admin)).rows[0].value
const cat=async(action:string,data:object={},key=`cat-${++serial}`)=>(await staffQuery<{value:any}>(db,'SELECT public.cai_catalog($1,$2::jsonb,$3) value',[action,JSON.stringify({expected_period:period,...data}),key],admin)).rows[0].value
test.beforeAll(async()=>{db=await createV13Database()})
test.beforeEach(async()=>{await resetDatabase(db,true);await db.exec("INSERT INTO pos.whatsapp_settings(id) VALUES(true); UPDATE pos.payment_methods SET requires_reference=false WHERE code='transfer'")})
test.afterAll(async()=>{await db.close()})
test('entrada 48 / 20.173 calcula costo preciso, stock mínimo 5 e idempotencia',async()=>{
 const data={name:'Producto nuevo',price:'1000',incoming_quantity:48,purchase_total:'20173'}
 const first=await cat('product.save',data,'same');expect(await cat('product.save',data,'same')).toEqual(first)
 expect(first).toMatchObject({stock:48,unit_cost:'420.270833',average_cost:'420.270833'})
 expect(await scalar(db,'SELECT minimum value FROM pos.products WHERE id=$1',[first.id])).toBe(5)
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.inventory_purchases')).toBe(1)
})
test('promedio ponderado usa stock real, conserva mínimo y rechaza entradas inválidas',async()=>{
 await db.query('UPDATE pos.products SET purchase_price=100,minimum=9 WHERE id=$1',[ids.product])
 const first=await cat('inventory.receive',{product_id:ids.product,version:1,incoming_quantity:50,purchase_total:'10000'})
 expect(first).toMatchObject({stock:150,average_cost:'133.333333'})
 expect(await scalar(db,'SELECT minimum value FROM pos.products WHERE id=$1',[ids.product])).toBe(9)
 await expect(cat('inventory.receive',{product_id:ids.product,version:1,incoming_quantity:2,purchase_total:'100'})).rejects.toThrow('VERSION_CONFLICT')
 for(const qty of [-1,1.5]) await expect(cat('inventory.receive',{product_id:ids.product,version:2,incoming_quantity:qty,purchase_total:'100'})).rejects.toThrow('INVALID_PURCHASE')
 await expect(cat('inventory.receive',{product_id:ids.product,version:2,incoming_quantity:0,purchase_total:'100'})).rejects.toThrow('INVALID_PURCHASE')
 expect(await scalar(db,'SELECT quantity value FROM pos.inventory_balances WHERE product_id=$1',[ids.product])).toBe(150)
})
test('reinicio explícito purga operación, conserva catálogos y reinicia V-1',async()=>{
 await op('sale.confirm',{session_id:ids.session,expected_total:'100',finance:true,customer_name:'Deudor',customer_phone:'3001234567',lines:[{product_id:ids.product,quantity:1}],payments:[]})
 const preview=await op('reset.preview')
 await expect(op('reset.confirm',{intent_id:preview.intent_id,confirmation:'REINICIAR OPERACION',reason:'Prueba local aislada'})).rejects.toThrow('RESET_CONFIRMATION_REQUIRED')
 const result=await op('reset.confirm',{intent_id:preview.intent_id,confirmation:'ELIMINAR OPERACION',reason:'Prueba local aislada'},'purge')
 expect(result.destructive).toBe(true)
 for(const table of ['sales','sale_items','credit_charges','credit_receipts','cash_sessions','inventory_adjustments','notification_jobs']) expect(await scalar(db,`SELECT count(*)::integer value FROM pos.${table}`)).toBe(0)
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.products')).toBe(1)
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.profiles')).toBe(2)
 expect(await scalar(db,'SELECT quantity value FROM pos.inventory_balances')).toBe(0)
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.operating_periods')).toBe(1)
 expect(await scalar(db,"SELECT nextval(pg_get_serial_sequence('pos.sales','number'))::integer value")).toBe(1)
 expect(await op('reset.confirm',{intent_id:preview.intent_id,confirmation:'ELIMINAR OPERACION',reason:'Prueba local aislada'},'purge')).toEqual(result)
})

async function sell(extra:object={},key=`sale-${++serial}`) {
 return op('sale.confirm',{session_id:ids.session,expected_total:'100',finance:true,customer_name:'Persona autorizada',customer_phone:'3001234567',lines:[{product_id:ids.product,quantity:1}],payments:[],...extra},key)
}
const secret='test-only-machine-capability-1234567890'
async function dispatch(action:string,data:object={}) {
 return (await db.query<{value:any}>('SELECT public.cai_whatsapp_dispatch($1,$2,$3::jsonb) value',[secret,action,JSON.stringify(data)])).rows[0].value
}
async function ready() {
 await db.query("UPDATE pos.whatsapp_settings SET worker_hash=sha256(convert_to($1,'UTF8')),enabled=true,connection_state='open',last_connection=clock_timestamp()",[secret])
}
test('contabilidad separa costo, créditos, abonos, caja, transferencia y gastos',async()=>{
 await db.query('UPDATE pos.products SET purchase_price=40 WHERE id=$1',[ids.product])
 const cash=await scalar<string>(db,"SELECT id value FROM pos.payment_methods WHERE code='cash'")
 const transfer=await scalar<string>(db,"SELECT id value FROM pos.payment_methods WHERE code='transfer'")
 const sale=await sell({payments:[{method_id:cash,amount:'25'}]})
 await op('debt.receipt',{charge_id:sale.charge_id,session_id:ids.session,method_id:transfer,amount:'25'})
 await op('cash.move',{session_id:ids.session,kind:'expense',amount:'10',reason:'Gasto operativo de prueba'})
 const report=(await staffQuery<{value:any}>(db,'SELECT public.cai_report($1::jsonb) value',[JSON.stringify({from:'2026-10-23',to:'2026-10-23'})],admin)).rows[0].value
 expect(report).toMatchObject({net_sales:'100.00',collections:'50.00',outstanding:'50.00',gross_profit:'60.000000',expenses:'10.00'})
 expect(report.financial).toMatchObject({cogs:'40.000000',net_profit:'50.000000',cash_received:'25.00',transfers_received:'25.00',cash_on_hand:'65.00',inventory_value:'3960.000000',gross_margin:'60.0000'})
 expect(report.financial.trend[0]).toMatchObject({receivable:'50.00',net_profit:'50.000000'})
})
test('cola requiere consentimiento nuevo; desconexión no pierde trabajos ni modifica deudas',async()=>{
 await ready()
 await sell()
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.notification_jobs')).toBe(0)
 const sale=await sell({notification_consent:true},'credit-consented')
 await sell({notification_consent:true},'credit-consented')
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.notification_jobs')).toBe(1)
 await db.exec("UPDATE pos.whatsapp_settings SET connection_state='close'")
 expect(await dispatch('claim')).toBe(null)
 expect(await scalar(db,"SELECT status value FROM pos.notification_jobs")).toBe('queued')
 expect(await scalar(db,'SELECT outstanding::text value FROM pos.credit_charge_balances WHERE id=$1',[sale.charge_id])).toBe('100.00')
 await dispatch('health',{state:'open'})
 const job=await dispatch('claim');expect(job).toMatchObject({kind:'credit_purchase',phone:'+573001234567'})
 expect(await dispatch('claim')).toBe(null)
 expect(await dispatch('preflight',{lease:job.lease})).not.toBe(null)
 await dispatch('finish',{lease:job.lease,outcome:'sent',provider_id:'provider-test-only'})
 expect(await scalar(db,"SELECT status value FROM pos.notification_jobs")).toBe('sent')
})
test('abono y deuda pagada producen avisos únicos; recordatorios omiten pagados y no tienen duplicados',async()=>{
 await ready()
 const sale=await sell({notification_consent:true,due_on:'2026-10-24'})
 await dispatch('enqueue');await dispatch('enqueue')
 expect(await scalar(db,"SELECT count(*)::integer value FROM pos.notification_jobs WHERE kind='reminder'")).toBe(1)
 const cash=await scalar<string>(db,"SELECT id value FROM pos.payment_methods WHERE code='cash'")
 const payload={charge_id:sale.charge_id,session_id:ids.session,method_id:cash,amount:'100'}
 await op('debt.receipt',payload,'full-receipt');await op('debt.receipt',payload,'full-receipt')
 expect(await scalar(db,"SELECT count(*)::integer value FROM pos.notification_jobs WHERE kind='receipt'")).toBe(1)
 expect(await scalar(db,"SELECT count(*)::integer value FROM pos.notification_jobs WHERE kind='debt_paid'")).toBe(1)
 for(let i=0;i<3;i++){const job=await dispatch('claim');if(job){expect(job.kind).not.toBe('reminder');await dispatch('finish',{lease:job.lease,outcome:'sent',provider_id:`test-${i}`})}}
 expect(await scalar(db,"SELECT status value FROM pos.notification_jobs WHERE kind='reminder'")).toBe('cancelled')
})
test('revocación entre reserva y envío cancela; resultado incierto nunca se reintenta ciegamente',async()=>{
 await ready();const sale=await sell({notification_consent:true})
 const job=await dispatch('claim')
 const customer=await scalar<string>(db,'SELECT customer_id value FROM pos.sales WHERE id=$1',[sale.sale_id])
 await op('whatsapp.contact',{customer_id:customer,granted:false,evidence:'Revocación explícita de prueba'})
 expect(await dispatch('preflight',{lease:job.lease})).toBe(null)
 await op('whatsapp.contact',{customer_id:customer,granted:true,evidence:'Autorización explícita de prueba'})
 await op('whatsapp.test',{customer_id:customer,authorized:true})
 const next=await dispatch('claim');await dispatch('finish',{lease:next.lease,outcome:'unknown'})
 expect(await dispatch('claim')).toBe(null)
 await expect(op('whatsapp.retry',{job_id:next.id})).rejects.toThrow('NOTIFICATION_NOT_RETRYABLE')
 await expect(db.query('SELECT public.cai_whatsapp_dispatch($1,$2)', ['wrong','claim'])).rejects.toThrow('FORBIDDEN')
 await expect(staffQuery(db,"SELECT public.cai_operations('whatsapp.status')",[],{sub:ids.actor,role:'authenticated',exp:4102444800})).rejects.toThrow('FORBIDDEN')
})
test('reinicio revierte completamente ante error y conserva operación si hay un envío en curso',async()=>{
 await ready();await sell({notification_consent:true});const job=await dispatch('claim')
 let preview=await op('reset.preview')
 const request=(intent:string)=>({intent_id:intent,confirmation:'ELIMINAR OPERACION',reason:'Ensayo exclusivamente local'})
 await expect(op('reset.confirm',request(preview.intent_id))).rejects.toThrow('NOTIFICATIONS_IN_PROGRESS')
 await dispatch('finish',{lease:job.lease,outcome:'sent',provider_id:'test-sent'})
 preview=await op('reset.preview')
 await db.exec("CREATE FUNCTION public.test_block_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_ROLLBACK'; END $$;CREATE TRIGGER test_block_delete BEFORE DELETE ON pos.sales FOR EACH STATEMENT EXECUTE FUNCTION public.test_block_delete();")
 await expect(op('reset.confirm',request(preview.intent_id))).rejects.toThrow('TEST_ROLLBACK')
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.sales')).toBe(1)
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.credit_charges')).toBe(1)
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.notification_jobs')).toBe(1)
 await db.exec('DROP TRIGGER test_block_delete ON pos.sales;DROP FUNCTION public.test_block_delete()')
 await op('reset.confirm',request(preview.intent_id))
 expect(await scalar(db,'SELECT count(*)::integer value FROM pos.notification_jobs')).toBe(0)
 expect(await scalar(db,'SELECT enabled value FROM pos.whatsapp_settings')).toBe(true)
})

test('migración conserva V1.2 y elimina también períodos históricos sólo con confirmación',async()=>{
 const legacy=await createV12Database()
 const execute=async(action:string,data:Record<string,unknown>,key:string)=>(await staffQuery<{value:any}>(legacy,'SELECT public.cai_operations($1,$2::jsonb,$3) value',[action,JSON.stringify(data),key],admin)).rows[0].value
 try {
  await resetDatabase(legacy,true)
  await legacy.query('UPDATE pos.products SET purchase_price=30,minimum=9 WHERE id=$1',[ids.product])
  const first=await execute('sale.confirm',{expected_period:period,session_id:ids.session,expected_total:'100',finance:true,customer_name:'Legacy debtor',customer_phone:'3001234567',lines:[{product_id:ids.product,quantity:1}],payments:[]},'legacy-sale')
  await execute('cash.close',{expected_period:period,session_id:ids.session,counted:'50'},'legacy-close')
  const preview=await execute('reset.preview',{expected_period:period},'legacy-preview')
  const archived=await execute('reset.confirm',{expected_period:period,intent_id:preview.intent_id,confirmation:'REINICIAR OPERACION',reason:'Isolated historical fixture'},'legacy-archive')
  const opened=await execute('cash.open',{expected_period:archived.period_id,register_code:'NEW',opening_float:'0'},'legacy-open')
  await staffQuery(legacy,"SELECT public.cai_catalog('inventory.adjust',$1::jsonb,'legacy-stock')",[JSON.stringify({expected_period:archived.period_id,product_id:ids.product,delta:5,reason:'Local fixture'})],admin)
  const second=await execute('sale.confirm',{expected_period:archived.period_id,session_id:opened.id,expected_total:'100',finance:true,customer_name:'Current debtor',customer_phone:'3007654321',lines:[{product_id:ids.product,quantity:1}],payments:[]},'legacy-sale-two')
  const before=(await legacy.query('SELECT id,sale_id,principal,due_on FROM pos.credit_charges ORDER BY id')).rows
  await legacy.exec('SET ROLE credit_migrator');await legacy.exec(await readFile('supabase/migrations/20261027001100_v13_operations.sql','utf8'));await legacy.exec('RESET ROLE')
  expect((await legacy.query('SELECT id,sale_id,principal,due_on FROM pos.credit_charges ORDER BY id')).rows).toEqual(before)
  expect(await scalar(legacy,'SELECT minimum value FROM pos.products')).toBe(9)
  expect(await scalar(legacy,'SELECT count(*)::integer value FROM pos.sales')).toBe(2)
  expect(await scalar(legacy,'SELECT count(*)::integer value FROM pos.notification_jobs')).toBe(0)
  const next=await execute('reset.preview',{expected_period:archived.period_id},'v13-preview')
  expect(next.sales).toBe(2)
  await execute('reset.confirm',{expected_period:archived.period_id,intent_id:next.intent_id,confirmation:'ELIMINAR OPERACION',reason:'Isolated full-history purge'},'v13-purge')
  expect(await scalar(legacy,'SELECT count(*)::integer value FROM pos.sales')).toBe(0)
  expect(await scalar(legacy,'SELECT count(*)::integer value FROM pos.credit_charges')).toBe(0)
  expect(await scalar(legacy,'SELECT count(*)::integer value FROM pos.operating_periods')).toBe(1)
  expect(first.sale_id).not.toBe(second.sale_id)
 }finally{await legacy.close()}
})
test('cajero no puede ejecutar reinicio ni helpers privados; funciones conservan búsqueda segura',async()=>{
 await expect(staffQuery(db,"SELECT public.cai_operations('reset.confirm',$1::jsonb,'forged')",[JSON.stringify({expected_period:period,confirmation:'ELIMINAR OPERACION'})],{sub:ids.actor,role:'authenticated',exp:4102444800})).rejects.toThrow('FORBIDDEN')
 for(const fn of ['pos.purge_operation(jsonb,uuid)','pos.receive_inventory(text,jsonb,text)','pos.notification_consent(uuid,uuid,boolean,text)'])expect(await scalar(db,"SELECT has_function_privilege($1,$2,'EXECUTE') value",['authenticated',fn])).toBe(false)
 expect(await scalar(db,"SELECT count(*)::integer value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('pos','public') AND p.prosecdef AND NOT EXISTS(SELECT FROM unnest(p.proconfig) x WHERE x LIKE 'search_path=pg_catalog%')")).toBe(0)
})
