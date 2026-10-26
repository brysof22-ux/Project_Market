import { test, expect } from '@playwright/test'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { prepareImage } from '../../worker/api/src/image-format'
import { createWorker } from '../../worker/api/src'
const actor = '10000000-0000-0000-0000-000000000001'
const base = { SUPABASE_URL:'https://unit.supabase.co', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake', ALLOWED_ORIGIN:'https://project-market.pages.dev' }
async function original(code: string) {
 const folder = code === 'nequi' ? 'QR Transferencias/nequi' : 'QR Transferencias/llaves Breve'
 const files = await readdir(folder).catch(() => [])
 if (!files.length) return prepareImage(new Uint8Array(await readFile(`tests/fixtures/demo-qr/${code === 'nequi' ? 'billetera-demo' : 'banco-demo'}.png`)), 'image/png')
 return prepareImage(new Uint8Array(await readFile(`${folder}/${files[0]}`)), 'image/jpeg')
}
test('originales Nequi y Bre-B válidos; prepara objetos privados sin alterar píxeles',async()=>{
 await mkdir('.cache/v12-assets',{recursive:true})
 for (const code of ['nequi','breb']) {
  const image=await original(code)
  expect(image.width).toBeGreaterThanOrEqual(64); expect(image.height).toBeGreaterThanOrEqual(64)
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256', image.bytes.slice().buffer)).toString('hex')
  await writeFile(`.cache/v12-assets/${code}.jpg`,image.bytes)
  await writeFile(`.cache/v12-assets/${code}.json`,JSON.stringify({code,image_id:hash,object_key:`transfer-qr/${hash}`,mime:image.mime,size:image.bytes.length,width:image.width,height:image.height}))
 }
})
test('Worker: admin reemplaza independientemente; cajero solo lectura; deduplicación y validaciones',async()=>{
 const objects=new Map<string,ArrayBuffer>(); const settings=new Map<string,unknown>(); let puts=0
 const api=createWorker(async(input,init)=>{
  const url=String(input)
  if(url.endsWith('/user'))return Response.json({id:actor})
  if(url.endsWith('/cai_current_profile'))return Response.json([{id:actor,display_name:'Prueba',role:new Headers(init?.headers).get('Authorization')?.includes('cashier')?'cashier':'admin',active:true}])
  const {p_action,p_data}=JSON.parse(String(init?.body))
  if(p_action==='qr.read')return Response.json(settings.get(p_data.code)??null)
  expect(p_action).toBe('qr.attach');settings.set(p_data.code,p_data);return Response.json({image_id:p_data.image_id})
 })
 const env={...base,MEDIA:{async get(key:string){const value=objects.get(key);return value?{body:new Blob([value]).stream(),size:value.byteLength,etag:'test'}:null},async put(key:string,value:ArrayBuffer){puts++;objects.set(key,value);return{etag:'test',size:value.byteLength}}}}
 const call=(code:string,method='GET',body?:ArrayBuffer,role='admin',expected='', mime='image/jpeg')=>api.fetch(new Request(`https://api.invalid/api/transfer-qr/${code}/image`,{method,headers:{Authorization:`Bearer ${role}.payload.signature`,'Content-Type':mime,'X-Expected-Image-Id':expected},body}),env)
 for(const code of ['nequi','breb']) {
  const image=await original(code)
  expect((await call(code,'POST',image.bytes.slice().buffer,'cashier','',image.mime)).status).toBe(403)
  expect((await call(code,'POST',image.bytes.slice().buffer,'admin','',image.mime)).status).toBe(201)
  const read=await call(code,'GET',undefined,'cashier');expect(read.status).toBe(200);expect(read.headers.get('Cache-Control')).toBe('no-store');expect(new Uint8Array(await read.arrayBuffer())).toEqual(image.bytes)
  expect((await call(code,'POST',image.bytes.slice().buffer,'admin','',image.mime)).status).toBe(200)
 }
 expect(puts).toBe(2)
 expect((await call('nequi','POST',new Uint8Array([1,2]).buffer,'admin','a'.repeat(64))).status).toBe(415)
 expect((await call('nequi','POST',(await original('breb')).bytes.slice().buffer,'admin','',(await original('breb')).mime)).status).toBe(409)
 expect((await call('nequi','POST',new ArrayBuffer(2097153),'admin','a'.repeat(64))).status).toBe(413)
 expect((await api.fetch(new Request('https://api.invalid/api/transfer-qr/nequi/image'),env)).status).toBe(401)
})
