import {test,expect} from './fixtures/auth'
test('fallo interno del reinicio conserva formulario y clave; no hay reintento automático',async({page})=>{
 const keys:string[]=[]
 await page.route('https://cai-api-test.invalid/api/operations',async route=>{
  const body=route.request().postDataJSON()
  if(body.action==='reset.confirm'){keys.push(body.key);return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'RESET_INTERNAL_ERROR',message:'PRIVATE_UPSTREAM_BODY'}})})}
  await route.fallback()
 })
 await page.goto('/#/configuracion');await page.getByRole('button',{name:'Datos y mantenimiento Períodos y operaciones avanzadas'}).click()
 await page.getByLabel('Confirma tu contraseña').fill('test-password-not-real');await page.getByRole('button',{name:'Verificar identidad y revisar alcance'}).click()
 await page.getByLabel('Motivo del reinicio').fill('Prueba local de error interno');await page.getByLabel('Escribe ELIMINAR OPERACION').fill('ELIMINAR OPERACION');await page.getByRole('checkbox',{name:/He revisado el alcance/}).check()
 await page.getByRole('button',{name:'Eliminar operación permanentemente'}).click();await expect(page.getByRole('alert').filter({hasText:'error interno'})).toContainText('RESET_INTERNAL_ERROR');await expect(page.getByText('PRIVATE_UPSTREAM_BODY')).toHaveCount(0)
 await page.waitForTimeout(500);expect(keys).toHaveLength(1);await expect(page.getByLabel('Motivo del reinicio')).toHaveValue('Prueba local de error interno')
 await page.getByRole('button',{name:'Eliminar operación permanentemente'}).click();await expect.poll(()=>keys.length).toBe(2);expect(keys[1]).toBe(keys[0])
})
