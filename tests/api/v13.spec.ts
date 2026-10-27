import {test,expect} from '@playwright/test'
import {parseCOP,purchasePreview} from '../../shared/money'
import {runWhatsApp,notificationText,type WhatsAppEnv} from '../../worker/api/src/whatsapp'
const config={url:'https://database.invalid',key:'sb_publishable_test'}
const env:WhatsAppEnv={EVOLUTION_API_URL:'https://evolution.invalid',EVOLUTION_API_KEY:'private-evolution-test-key',EVOLUTION_INSTANCE:'cai-market',WHATSAPP_DISPATCH_SECRET:'private-capability-test-only-long-enough'}
const job={lease:'70000000-0000-4000-8000-000000000001',kind:'receipt',phone:'+573001234567',payload:{name:'Cliente ficticio',receipt_amount:'3000',previous_balance:'7000',outstanding:'4000'}}
test('COP interpreta miles y decimales sin convertir negativos ni unidades fraccionarias',()=>{
 for(const [input,expected] of [['20.173','20173.00'],['20.173,25','20173.25'],['420,27','420.27'],['420.27','420.27']])expect(parseCOP(input)).toBe(expected)
 for(const value of ['-1','1,234','1.2.3','NaN',''])expect(parseCOP(value)).toBe(null)
 expect(purchasePreview('48','20.173',20)).toMatchObject({valid:true,available:68,total:'20173.00'})
 expect(purchasePreview('0','0',20)).toMatchObject({valid:true,unit:null,available:20})
 expect(purchasePreview('1.5','100',20).valid).toBe(false)
})
test('transporte sin configuración y desconectado no envía ni pierde trabajos',async()=>{
 let sends=0,claims=0
 const upstream=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input)
  if(url.includes('fetchInstances'))return Response.json([{ownerJid:'573001234567@s.whatsapp.net',token:'do-not-expose-provider-secret'}])
  if(url.includes('connectionState'))return Response.json({instance:{state:'close'}})
  if(url.includes('sendText'))sends++
  const action=JSON.parse(String(init?.body)).p_action;if(action==='claim')claims++
  return Response.json({enabled:true})
 }
 expect(await runWhatsApp({},config,upstream)).toMatchObject({status:'unconfigured'})
 expect(await runWhatsApp(env,config,upstream)).toMatchObject({status:'disconnected'})
 expect(sends).toBe(0);expect(claims).toBe(0)
 expect(await runWhatsApp({...env,EVOLUTION_API_URL:'https://demo.trycloudflare.com'},config,upstream)).toMatchObject({status:'unconfigured'})
})
for(const result of ['accepted','rate-limit','rejected','timeout','server-error'] as const) {
 test(`Evolution ${result}: clasificación evita reenvío ambiguo y protege claves`,async()=>{
  let claimed=false,sends=0;const finishes:Record<string,unknown>[]=[]
  const upstream=async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=String(input)
   if(url.includes('fetchInstances'))return Response.json([{ownerJid:'573001234567@s.whatsapp.net',token:'do-not-expose-provider-secret'}])
  if(url.includes('connectionState'))return Response.json({instance:{state:'open'}})
   if(url.includes('sendText')) {
    sends++;expect(new Headers(init?.headers).get('apikey')).toBe(env.EVOLUTION_API_KEY)
    const body=JSON.parse(String(init?.body));expect(body.number).toBe('573001234567');expect(body.text).toContain('4.000')
    expect(body.text).not.toContain(env.EVOLUTION_API_KEY)
    if(result==='timeout')throw new TypeError('Network failure')
    if(result==='rate-limit')return new Response(null,{status:429})
    if(result==='rejected')return new Response(null,{status:400})
    if(result==='server-error')return new Response(null,{status:503})
    return Response.json({key:{id:'provider-id-test'}})
   }
   const body=JSON.parse(String(init?.body))
   if(body.p_action==='claim'){if(claimed)return Response.json(null);claimed=true;return Response.json(job)}
   if(body.p_action==='preflight')return Response.json(job)
   if(body.p_action==='finish')finishes.push(body.p_data)
   return Response.json({enabled:true})
  }
  await runWhatsApp(env,config,upstream)
  expect(sends).toBe(1)
  expect(finishes[0].outcome).toBe(result==='accepted'?'sent':result==='rate-limit'?'retry':result==='rejected'?'failed':'unknown')
 })
}
test('mensajes de compra, recordatorio, abono y saldada usan datos persistidos',()=>{
 for(const kind of ['credit_purchase','reminder','receipt','debt_paid'])expect(notificationText({...job,kind,payload:{...job.payload,total:'9000',initial_payment:'2000',due_on:'2026-10-30',products:[{quantity:2,name:'Producto ficticio',total:'9000'}]}})).toContain('Cliente ficticio')
})
