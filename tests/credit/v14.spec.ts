import {test,expect} from '@playwright/test'
import {createV14Database} from './v14-fixture'
import {resetDatabase,staffQuery,ids,scalar} from './fixture'
import type {PGlite} from '@electric-sql/pglite'
let db:PGlite;let n=0;const claims={sub:ids.otherActor,role:'authenticated',exp:4102444800};const period='11111111-1111-4111-8111-111111111111'
const op=async(action:string,data:object={},key=`v14-${++n}`,actor=claims)=>(await staffQuery<{value:any}>(db,'SELECT public.cai_operations($1,$2::jsonb,$3) value',[action,JSON.stringify({expected_period:period,...data}),key],actor)).rows[0].value
test.beforeAll(async()=>{db=await createV14Database()});test.afterAll(async()=>{await db.close()})
test.beforeEach(async()=>{await resetDatabase(db,true);await db.exec("INSERT INTO pos.whatsapp_settings(id) VALUES(true);UPDATE pos.cash_sessions SET operator_id='10000000-0000-0000-0000-000000000002';UPDATE pos.payment_methods SET requires_reference=false WHERE code='transfer'")})
test('transferencias y traslados no reducen efectivo ni aumentan ventas; movimientos son idempotentes',async()=>{
 const payload={session_id:ids.session,amount:30,kind:'expense',method:'transfer',reason:'Servicios',purpose:'operating'}
 const one=await op('cash.move',payload,'same');expect(await op('cash.move',payload,'same')).toEqual(one)
 expect((await op('bootstrap')).session.expected).toBe(50)
 await op('cash.move',{session_id:ids.session,amount:10,kind:'expense',method:'cash',reason:'Retiro',purpose:'internal'})
 expect((await op('bootstrap')).session.expected).toBe(40)
 const report=(await staffQuery<{v:any}>(db,`SELECT public.cai_report('{"from":"2026-10-23","to":"2026-10-23"}') v`,[],claims)).rows[0].v
 expect(report.net_sales).toBe('0');expect(Number(report.expenses)).toBe(30);expect(Number(report.financial.cash_on_hand)).toBe(40)
 const summary=await op('finance.summary');expect(Number(summary.cash_out)).toBe(10);expect(Number(summary.transfer_out)).toBe(30)
 expect(await scalar(db,'SELECT count(*)::int value FROM pos.cash_adjustments')).toBe(2)
})
test('historial y detalle conservan cierre y calculan diferencias',async()=>{
 const closed=await op('cash.close',{session_id:ids.session,counted:55,note:'Sobrante verificado'})
 expect(Number(closed.difference)).toBe(5)
 const detail=await op('cash.detail',{id:ids.session});expect(detail.closing_note).toBe('Sobrante verificado');expect(detail.expected).toBe(50)
 expect((await op('cash.history',{status:'closed'})).total).toBe(1)
 await expect(op('cash.close',{session_id:ids.session,counted:55})).rejects.toThrow('CASH_SESSION_NOT_OPEN')
 await expect(op('cash.move',{session_id:ids.session,amount:5,kind:'income',reason:'Tarde'})).rejects.toThrow('CASH_SESSION_NOT_OPEN')
})
test('ventas de hoy usa Bogotá y filtros sin contar crédito como recibido',async()=>{
 await op('sale.confirm',{session_id:ids.session,finance:true,customer_name:'Cliente Hoy',customer_phone:'3001234567',expected_total:'100',lines:[{product_id:ids.product,quantity:1}],payments:[]})
 const page=await op('sales.today');expect(page.day).toBe('2026-10-23');expect(page.total).toBe(1);expect(Number(page.summary.net_sales)).toBe(100);expect(Number(page.summary.received)).toBe(0);expect(Number(page.summary.credit)).toBe(100)
 expect((await op('sales.today',{method:'credit',status:'pending',search:'Hoy'})).total).toBe(1)
 expect((await op('sales.today',{method:'cash'})).total).toBe(0)
 const detail=await op('sales.detail',{id:page.rows[0].id});expect(detail.customer).toBe('Cliente Hoy')
})
test('cajero no accede a finanzas y configuración exige versión vigente',async()=>{
 for(const action of ['sales.today','finance.summary','cash.history','cash.detail']) await expect(op(action,{},undefined,{...claims,sub:ids.actor})).rejects.toThrow('FORBIDDEN')
 await op('settings.save',{name:'Mi negocio',address:'Bogotá',version:0})
 await expect(op('settings.save',{name:'Nombre obsoleto',address:'',version:0})).rejects.toThrow('VERSION_CONFLICT')
 expect((await op('bootstrap')).settings.name).toBe('Mi negocio')
})
test('día comercial cambia a medianoche de Bogotá, independientemente de UTC',async()=>{
 const clock=async(time:string)=>db.exec(`CREATE OR REPLACE FUNCTION pos.business_now() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT timestamptz '${time}' $$`)
 const sale=()=>op('sale.confirm',{session_id:ids.session,finance:true,customer_name:'Cliente horario',customer_phone:'3001234567',expected_total:'100',lines:[{product_id:ids.product,quantity:1}],payments:[]})
 await clock('2026-10-24 04:59:59+00');await sale();expect((await op('sales.today')).day).toBe('2026-10-23')
 await clock('2026-10-24 05:00:00+00');await sale();const page=await op('sales.today');expect(page.day).toBe('2026-10-24');expect(page.total).toBe(1);expect(page.rows[0].number).toBe(2)
})
test('devolución en transferencia se netea una vez y conserva efectivo físico',async()=>{
 const cash=await scalar<string>(db,"SELECT id value FROM pos.payment_methods WHERE code='cash'");const transfer=await scalar<string>(db,"SELECT id value FROM pos.payment_methods WHERE code='transfer'")
 await db.query("INSERT INTO pos.transfer_qr_media(image_id,object_key,mime,size,width,height,created_by) VALUES(repeat('a',64),'transfer-qr/'||repeat('a',64),'image/png',1,64,64,$1);",[ids.otherActor]);await db.exec("INSERT INTO pos.transfer_qr(code,name,image_id) VALUES('nequi','Nequi',repeat('a',64))")
 const sale=await op('sale.confirm',{session_id:ids.session,expected_total:'100',finance:false,lines:[{product_id:ids.product,quantity:1}],payments:[{method_id:cash,amount:40},{method_id:transfer,amount:60,manually_verified:true,qr_code:'nequi',qr_image_id:'a'.repeat(64)}],confirm_payment:true,transfer_confirmed:true,qr_code:'nequi'})
 await op('sale.return',{session_id:ids.session,sale_id:sale.sale_id,method_id:transfer,reason:'Devolución de prueba'})
 const page=await op('finance.summary');expect(page.total).toBe(3);expect(Number(page.cash_balance)).toBe(40);expect(Number(page.transfer_balance)).toBe(-40);expect((await op('bootstrap')).session.expected).toBe(90)
 expect(Number((await op('sales.today')).summary.net_sales)).toBe(0)
})
test('validación de movimientos, apertura con notas y funciones privadas',async()=>{
 await expect(op('cash.move',{session_id:ids.session,amount:51,kind:'expense',method:'cash',reason:'Exceso'})).rejects.toThrow('INSUFFICIENT_CASH')
 for(const data of [{amount:-1},{amount:1,method:'card'},{amount:1,purpose:'inventado'},{amount:1,date:'2026-10-22'}])await expect(op('cash.move',{session_id:ids.session,kind:'income',reason:'Validación',...data})).rejects.toThrow()
 await op('cash.close',{session_id:ids.session,counted:50});await op('cash.open',{register_code:'V14',opening_float:20,note:'Apertura anotada'})
 expect((await op('bootstrap')).session.opening_note).toBe('Apertura anotada')
 expect(await scalar(db,"SELECT has_function_privilege('authenticated','pos.cash_expected_v14(uuid)','EXECUTE') value")).toBe(false)
 expect(await scalar(db,"SELECT has_table_privilege('authenticated','pos.finance_ledger_v14','SELECT') value")).toBe(false)
})
test('cierre rechaza un efectivo esperado obsoleto y mantiene idempotencia',async()=>{
 await op('cash.move',{session_id:ids.session,kind:'income',amount:1,reason:'Ingreso concurrente'})
 await expect(op('cash.close',{session_id:ids.session,expected_cash:50,counted:50})).rejects.toThrow('VERSION_CONFLICT')
 expect((await op('bootstrap')).session.closed_at).toBeNull()
 const data={session_id:ids.session,expected_cash:51,counted:51};const closed=await op('cash.close',data,'same-close');expect(await op('cash.close',data,'same-close')).toEqual(closed)
})
