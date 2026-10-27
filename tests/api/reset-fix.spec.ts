import {test,expect} from '@playwright/test'
import {createWorker,type Env} from '../../worker/api/src'
import {createApiClient} from '../../src/lib/api-client'
const actor='10000000-0000-0000-0000-000000000002'
const env:Env={SUPABASE_URL:'https://unit.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',ALLOWED_ORIGIN:'https://project-market.pages.dev',MEDIA:{}}
function fixture(rpc:()=>Response|Promise<Response>){
 const encode=(value:object)=>Buffer.from(JSON.stringify(value)).toString('base64url');const token=`${encode({alg:'HS256'})}.${encode({sub:actor,session_id:'90000000-0000-4000-8000-000000000001',amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]})}.fake_signature`
 const worker=createWorker(async input=>{const url=String(input);if(url.endsWith('/user'))return Response.json({id:actor});if(url.endsWith('/cai_current_profile'))return Response.json([{id:actor,display_name:'Admin de prueba',active:true,role:'admin'}]);return rpc()})
 const client=createApiClient({baseUrl:'https://api.test',getSession:async()=>({access_token:token}),fetcher:async(input,init)=>worker.fetch(new Request(input,init),env)})
 return {client,request:()=>worker.fetch(new Request('https://api.test/api/operations',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'reset.confirm',data:{},key:'same-reset-key'})}),env)}
}
for(const [http,message,sqlstate,status,code,copy] of [
 [400,'RESET_INTENT_EXPIRED','P0001',422,'RESET_INTENT_EXPIRED','La confirmación venció'],
 [400,'RESET_PREVIEW_CHANGED','P0001',422,'RESET_PREVIEW_CHANGED','Los datos cambiaron'],
 [400,'RESET_INTENT_INVALID','P0001',422,'RESET_INTENT_INVALID','no corresponde a tu sesión'],
 [400,'RESET_CONFIRMATION_REQUIRED','P0001',422,'RESET_CONFIRMATION_REQUIRED','motivo'],
 [403,'FORBIDDEN','42501',403,'FORBIDDEN','No tienes permiso'],
 [403,'RECENT_AUTH_REQUIRED','42501',403,'RECENT_AUTH_REQUIRED','Confirma de nuevo tu identidad'],
 [500,'OPERATION_IN_PROGRESS','55P03',422,'OPERATION_IN_PROGRESS','operación concurrente'],
 [400,'DELETE requires a WHERE clause','21000',500,'RESET_INTERNAL_ERROR','error interno'],
 [409,'PRIVATE_SQL_CONSTRAINT','23503',500,'RESET_INTERNAL_ERROR','error interno'],
 [500,'PRIVATE_INTERNAL_EXCEPTION','XX000',500,'RESET_INTERNAL_ERROR','error interno'],
] as const)test(`reinicio ${http}/${sqlstate}/${message}: respuesta diferenciada y privada`,async()=>{
 const logs:string[]=[];const warn=console.warn;console.warn=(...parts)=>logs.push(parts.join(' '))
 try{const f=fixture(()=>Response.json({message,code:sqlstate,details:'PRIVATE_SQL_BODY',hint:'PRIVATE_TOKEN'},{status:http}));const response=await f.request();expect(response.status).toBe(status);const body=await response.text();expect(JSON.parse(body).error.code).toBe(code)
 let error:any;try{await f.client.operations('reset.confirm',{},'same-reset-key')}catch(cause){error=cause}expect(error).toMatchObject({status,code});expect(error.message).toContain(copy)
 const output=body+logs.join(' ')+error.message;for(const secret of ['PRIVATE_SQL_BODY','PRIVATE_TOKEN','DELETE requires','PRIVATE_SQL_CONSTRAINT','PRIVATE_INTERNAL_EXCEPTION','fake_signature'])expect(output).not.toContain(secret)
 }finally{console.warn=warn}
})
test('timeout del RPC no confirma ni repite automáticamente el reinicio',async()=>{
 let calls=0;const f=fixture(()=>{calls++;throw new Error('PRIVATE_NETWORK_ERROR')});await expect(f.client.operations('reset.confirm',{},'same-reset-key')).rejects.toMatchObject({status:503,code:'RESET_RESULT_UNKNOWN'});expect(calls).toBe(1)
})
