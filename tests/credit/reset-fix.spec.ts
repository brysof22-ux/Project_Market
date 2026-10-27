import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {createResetFixDatabase} from './reset-fix-fixture'
import {resetDatabase,staffQuery,ids,scalar} from './fixture'
import type {PGlite} from '@electric-sql/pglite'
let db:PGlite;let serial=0
const period='11111111-1111-4111-8111-111111111111'
const claims=()=>({sub:ids.otherActor,role:'authenticated',exp:4102444800,session_id:'90000000-0000-4000-8000-000000000001',amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]})
const op=async(action:string,data:object={},key=`reset-test-${++serial}`,auth:Record<string,unknown>=claims())=>(await staffQuery<{value:any}>(db,'SELECT public.cai_operations($1,$2::jsonb,$3) value',[action,JSON.stringify({expected_period:period,...data}),key],auth)).rows[0].value
const cat=async(data:object)=>(await staffQuery<{value:any}>(db,"SELECT public.cai_catalog('product.save',$1::jsonb,$2) value",[JSON.stringify({expected_period:period,...data}),`catalog-${++serial}`],claims())).rows[0].value
const confirm=(preview:{intent_id:string})=>({intent_id:preview.intent_id,confirmation:'ELIMINAR OPERACION',reason:'Prueba con registros sintéticos locales'})
const snapshot=()=>scalar(db,'SELECT pos.reset_snapshot_v13() value')
async function seed(){
 await cat({id:ids.product,version:1,name:'Producto aislado',price:500,minimum:9,incoming_quantity:220,purchase_total:22000})
 const cash=await scalar<string>(db,"SELECT id value FROM pos.payment_methods WHERE code='cash'")
 const charges:string[]=[]
 for(let i=0;i<7;i++){
  const sale=await op('sale.confirm',{session_id:ids.session,expected_total:'500',finance:i<4,customer_name:`Cliente sintético ${i}`,customer_phone:'3001234567',lines:[{product_id:ids.product,quantity:1}],payments:i<4?[]:[{method_id:cash,amount:500}]})
  if(i<4)charges.push(sale.charge_id)
 }
 for(const charge_id of charges.slice(0,2))await op('debt.receipt',{session_id:ids.session,charge_id,method_id:cash,amount:500})
 await op('cash.close',{session_id:ids.session,counted:2550})
}
test.beforeAll(async()=>{db=await createResetFixDatabase()});test.afterAll(async()=>{await db.close()})
test.beforeEach(async()=>{await resetDatabase(db,true);await db.exec("INSERT INTO pos.whatsapp_settings(id) VALUES(true);UPDATE pos.payment_methods SET requires_reference=false WHERE code='transfer'")})
test('regresión safeupdate: todas las eliminaciones tienen WHERE y claves no anulables',async()=>{
 const old=await readFile('supabase/migrations/20261027001100_v13_operations.sql','utf8');expect(old).toContain("EXECUTE format('DELETE FROM pos.%I',name)")
 const body=String(await scalar(db,"SELECT prosrc value FROM pg_proc WHERE oid='pos.purge_operation(jsonb,uuid)'::regprocedure"))
 expect(body).toContain("DELETE FROM pos.%I WHERE %I IS NOT NULL");expect(body).toContain('DELETE FROM pos.reset_intents WHERE id IS NOT NULL');expect(body).not.toMatch(/DELETE FROM pos\.%I[';]/);expect(body).not.toMatch(/safeupdate\.enabled|TRUNCATE/i)
 const names=body.match(/FOREACH name IN ARRAY ARRAY\[([^\]]+)\]/)![1].match(/'([^']+)'/g)!.map(v=>v.slice(1,-1))
 for(const name of names){const column=name==='inventory_balances'?'product_id':name==='idempotency_requests'?'actor_id':'id';expect(await scalar(db,'SELECT attnotnull value FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname=$2',[`pos.${name}`,column])).toBe(true)}
})
test('reinicio aislado con siete ventas, cuatro deudas, stock 313 y caja cerrada; conserva catálogos y reintento',async()=>{
 await seed();const preview=await op('reset.preview');expect(preview).toMatchObject({sales:7,debts:4,stock:313,open_sessions:0});expect(Number(preview.outstanding)).toBe(1000)
 const catalog=await db.query('SELECT to_jsonb(p) product FROM pos.products p');const contacts=await db.query('SELECT to_jsonb(c) customer FROM pos.customers c ORDER BY id');const settings=await db.query('SELECT to_jsonb(s) settings FROM pos.whatsapp_settings s')
 const request=confirm(preview),first=await op('reset.confirm',request,'same-reset');expect(first.destructive).toBe(true);expect(await op('reset.confirm',request,'same-reset')).toEqual(first)
 for(const name of ['sales','sale_items','payments','credit_charges','credit_receipts','credit_allocations','cash_sessions','cash_closings','inventory_purchases','reset_intents'])expect(await scalar(db,`SELECT count(*)::int value FROM pos.${name}`)).toBe(0)
 expect(await db.query('SELECT to_jsonb(p) product FROM pos.products p')).toEqual(catalog);expect(await db.query('SELECT to_jsonb(c) customer FROM pos.customers c ORDER BY id')).toEqual(contacts);expect(await db.query('SELECT to_jsonb(s) settings FROM pos.whatsapp_settings s')).toEqual(settings)
 expect(await scalar(db,'SELECT sum(quantity)::int value FROM pos.inventory_balances')).toBe(0);expect(await scalar(db,"SELECT nextval(pg_get_serial_sequence('pos.sales','number'))::int value")).toBe(1)
 expect(await scalar(db,'SELECT count(*)::int value FROM pos.profiles')).toBe(2)
})
test('fallo al final revierte todas las filas, período, intento y secuencia; mismo intento puede reintentarse',async()=>{
 await seed();const preview=await op('reset.preview'),before=await snapshot(),sequence=await db.query('SELECT last_value,is_called FROM pos.sales_number_seq')
 await db.exec("CREATE FUNCTION public.test_fail_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='operation.destructive_reset' THEN RAISE EXCEPTION 'TEST_ATOMICITY_FAILURE';END IF;RETURN NEW;END $$;CREATE TRIGGER test_fail_reset BEFORE INSERT ON pos.audit_events FOR EACH ROW EXECUTE FUNCTION public.test_fail_reset();")
 await expect(op('reset.confirm',confirm(preview),'retry-failure')).rejects.toThrow('TEST_ATOMICITY_FAILURE')
 expect(await snapshot()).toEqual(before);expect(await db.query('SELECT last_value,is_called FROM pos.sales_number_seq')).toEqual(sequence);expect(await scalar(db,'SELECT consumed_at IS NULL value FROM pos.reset_intents WHERE id=$1',[preview.intent_id])).toBe(true)
 await db.exec('DROP TRIGGER test_fail_reset ON pos.audit_events;DROP FUNCTION public.test_fail_reset()')
 expect((await op('reset.confirm',confirm(preview),'retry-failure')).destructive).toBe(true)
})
test('confirmación vencida y sesión ajena fallan antes del borrado',async()=>{
 await seed();let preview=await op('reset.preview');const before=await snapshot()
 await db.query("UPDATE pos.reset_intents SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[preview.intent_id])
 await expect(op('reset.confirm',confirm(preview))).rejects.toThrow('RESET_INTENT_EXPIRED');expect(await snapshot()).toEqual(before)
 preview=await op('reset.preview');await expect(op('reset.confirm',confirm(preview),undefined,{...claims(),session_id:'90000000-0000-4000-8000-000000000002'})).rejects.toThrow('RESET_INTENT_INVALID');expect(await snapshot()).toEqual(before)
})
test('datos modificados exigen nueva revisión; permisos, identidad y frase siguen obligatorios',async()=>{
 await seed();const preview=await op('reset.preview')
 const before=await snapshot();await expect(op('reset.confirm',{...confirm(preview),confirmation:'REINICIAR OPERACION'})).rejects.toThrow('RESET_CONFIRMATION_REQUIRED')
 await expect(op('reset.confirm',confirm(preview),undefined,{...claims(),sub:ids.actor})).rejects.toThrow('FORBIDDEN')
 await expect(op('reset.confirm',confirm(preview),undefined,{...claims(),amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)-301}]})).rejects.toThrow('RECENT_AUTH_REQUIRED');expect(await snapshot()).toEqual(before)
 await op('cash.open',{opening_float:0,register_code:'CHANGED'});const changed=await snapshot()
 await expect(op('reset.confirm',confirm(preview))).rejects.toThrow('RESET_PREVIEW_CHANGED');expect(await snapshot()).toEqual(changed)
 expect(await scalar(db,"SELECT has_function_privilege('authenticated','pos.purge_operation(jsonb,uuid)','EXECUTE') value")).toBe(false)
})
