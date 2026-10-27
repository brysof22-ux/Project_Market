import {CatalogError} from './catalog'
export type WhatsAppEnv = { EVOLUTION_API_URL?:string; EVOLUTION_API_KEY?:string; EVOLUTION_INSTANCE?:string; WHATSAPP_DISPATCH_SECRET?:string; CF_ACCESS_CLIENT_ID?:string; CF_ACCESS_CLIENT_SECRET?:string; LOCAL_ONLY?:string }
type Upstream=(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>
type Config={url:string;key:string}
type Job={lease:string;kind:string;phone:string;payload:Record<string,unknown>}
function evolution(env:WhatsAppEnv) {
 if(!env.EVOLUTION_API_URL||!env.EVOLUTION_API_KEY||!env.WHATSAPP_DISPATCH_SECRET)return null
 const url=new URL(env.EVOLUTION_API_URL)
 const local=env.LOCAL_ONLY==='true'&&['localhost','127.0.0.1'].includes(url.hostname)
 if((url.protocol!=='https:'&&!local)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.hostname.endsWith('.trycloudflare.com'))return null
 const instance=env.EVOLUTION_INSTANCE??'cai-market'
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(instance))return null
 const headers:Record<string,string>={apikey:env.EVOLUTION_API_KEY,'Content-Type':'application/json'}
 if(env.CF_ACCESS_CLIENT_ID&&env.CF_ACCESS_CLIENT_SECRET){headers['CF-Access-Client-Id']=env.CF_ACCESS_CLIENT_ID;headers['CF-Access-Client-Secret']=env.CF_ACCESS_CLIENT_SECRET}
 return {url:url.origin,instance,headers}
}
async function dispatch(env:WhatsAppEnv,config:Config,upstream:Upstream,action:string,data:object={}) {
 const response=await upstream(`${config.url}/rest/v1/rpc/cai_whatsapp_dispatch`,{method:'POST',headers:{apikey:config.key,'Content-Type':'application/json','Content-Profile':'public'},body:JSON.stringify({p_secret:env.WHATSAPP_DISPATCH_SECRET,p_action:action,p_data:data}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)})
 if(!response.ok)throw new CatalogError(503,'WHATSAPP_UNAVAILABLE','No se pudo consultar la cola de WhatsApp.')
 return response.json() as Promise<unknown>
}
export async function refreshEvolutionHealth(env:WhatsAppEnv,config:Config,upstream:Upstream) {
 let state='unconfigured';let provider:ReturnType<typeof evolution>=null
 try {provider=evolution(env)}catch { /* Invalid administrator configuration remains closed. */ }
 if(provider)try {
  const response=await upstream(`${provider.url}/instance/connectionState/${provider.instance}`,{headers:provider.headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)})
  const data=await response.json() as {instance?:{state?:unknown}}
  state=response.ok&&typeof data.instance?.state==='string'&&['open','close','connecting'].includes(data.instance.state)?data.instance.state:'unavailable'
 }catch{state='unavailable'}
 let connectedNumber:string|null=null
 if(state==='open'&&provider)try {
  const response=await upstream(`${provider.url}/instance/fetchInstances?instanceName=${encodeURIComponent(provider.instance)}`,{headers:provider.headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)})
  const rows:unknown=await response.json()
  if(response.ok&&Array.isArray(rows))for(const value of rows){
   if(!value||typeof value!=='object')continue
   const row=value as {ownerJid?:unknown;instance?:{ownerJid?:unknown}}
   const jid=row.ownerJid??row.instance?.ownerJid
   if(typeof jid==='string'&&/^[1-9][0-9]{7,14}@s\.whatsapp\.net$/.test(jid)){connectedNumber=`+${jid.split('@')[0]}`;break}
  }
 }catch{/* Number metadata is optional; never expose the full provider response. */}
 if(env.WHATSAPP_DISPATCH_SECRET)await dispatch(env,config,upstream,'health',{state,connected_number:connectedNumber})
 return state
}
const amount=(value:unknown)=>typeof value==='string'&&/^-?\d+(?:\.\d{1,6})?$/.test(value)?new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:2}).format(Number(value)):'No disponible'
export function notificationText(job:Job):string {
 const p=job.payload,name=typeof p.name==='string'?p.name.slice(0,160):'cliente'
 if(job.kind==='test')return `CAI Market: mensaje de prueba autorizado para ${name}. No registra ventas ni pagos.`
 if(job.kind==='reminder')return `Hola, ${name}.\nTe recordamos tu compra a crédito en CAI Market.\nSaldo pendiente: ${amount(p.outstanding)}\nFecha de vencimiento: ${p.due_on}.\nGracias por tu atención.`
 if(job.kind==='receipt')return `Hola, ${name}.\nRecibimos tu abono de ${amount(p.receipt_amount)}.\nSaldo anterior: ${amount(p.previous_balance)}\nSaldo pendiente al registrar el abono: ${amount(p.outstanding)}.\nGracias por tu pago.`
 if(job.kind==='debt_paid')return `Hola, ${name}.\nTu deuda con CAI Market ha sido pagada completamente.\nSaldo pendiente: $0.\nGracias por tu compra.`
 if(job.kind!=='credit_purchase')throw new Error('INVALID_NOTIFICATION')
 const products=Array.isArray(p.products)?p.products.slice(0,100).map((x:Record<string,unknown>)=>`${x.quantity} × ${String(x.name).slice(0,160)}: ${amount(x.total)}`).join('\n'):''
 return `Hola, ${name}.\nGracias por comprar en CAI Market.\n${products}\nTotal: ${amount(p.total)}\nAbono inicial: ${amount(p.initial_payment)}\nSaldo pendiente al registrar la compra: ${amount(p.outstanding)}\nFecha límite: ${p.due_on??'Sin vencimiento'}.`
}
function validJob(value:unknown):value is Job {
 if(!value||typeof value!=='object')return false
 const row=value as Record<string,unknown>
 return typeof row.lease==='string'&&/^[0-9a-f-]{36}$/i.test(row.lease)&&typeof row.phone==='string'&&/^\+[1-9][0-9]{7,14}$/.test(row.phone)&&typeof row.kind==='string'&&!!row.payload&&typeof row.payload==='object'
}
export async function runWhatsApp(env:WhatsAppEnv,config:Config,upstream:Upstream=fetch) {
 let provider:ReturnType<typeof evolution>=null
 try{provider=evolution(env)}catch{/* Closed until administrator configuration is valid. */}
 if(!provider)return {status:'unconfigured',sent:0}
 if(await refreshEvolutionHealth(env,config,upstream)!=='open')return {status:'disconnected',sent:0}
 await dispatch(env,config,upstream,'enqueue')
 let sent=0
 for(let index=0;index<10;index++) {
  const reservation=await dispatch(env,config,upstream,'claim')
  if(!reservation)break
  if(!validJob(reservation))throw new Error('INVALID_NOTIFICATION_JOB')
  const job=await dispatch(env,config,upstream,'preflight',{lease:reservation.lease})
  if(!job)continue
  if(!validJob(job))throw new Error('INVALID_NOTIFICATION_JOB')
  let outcome='unknown',providerId:string|undefined
  try {
   const response=await upstream(`${provider.url}/message/sendText/${provider.instance}`,{method:'POST',headers:provider.headers,body:JSON.stringify({number:job.phone.slice(1),text:notificationText(job),linkPreview:false}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)})
   if(response.ok){const value=await response.json() as {key?:{id?:unknown}};if(typeof value.key?.id==='string'&&value.key.id.length<=200){outcome='sent';providerId=value.key.id;sent++}}
   else if(response.status===429)outcome='retry'
   else if([400,401,403,404,422].includes(response.status))outcome='failed'
  }catch{ /* The POST may have committed at the provider. Never blindly retry. */ }
  await dispatch(env,config,upstream,'finish',{lease:job.lease,outcome,provider_id:providerId})
 }
 return {status:'processed',sent}
}
