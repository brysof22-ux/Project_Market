import type { Page } from '@playwright/test'
import { test, expect, authUser, mockAuth } from './fixtures/auth'

async function seedDebts(page: Page) {
  await page.goto('/#/creditos')
  return page.evaluate(async () => {
    const command = async (section: string, action: string, data = {}, key?: string) => {
      const response = await fetch(`https://cai-api-test.invalid/api/${section}`, { method: 'POST', headers: { Authorization: 'Bearer fake.payload.signature', 'Content-Type': 'application/json' }, body: JSON.stringify({ action, data, key }) })
      if (!response.ok) throw new Error(`Fixture ${action}: ${response.status}`)
      return response.json()
    }
    const bootstrap = await command('operations', 'bootstrap')
    const product = (await command('catalog', 'products.list')).rows.find((row: {stock:number}) => row.stock > 2)
    const data = { expected_period: bootstrap.period_id, session_id: bootstrap.session.id, finance: true, expected_total: product.price, lines: [{product_id:product.id,quantity:1}],payments:[] }
    await command('operations','sale.confirm',{...data,customer_name:'Cliente QR compartido',customer_phone:'3001234567'},'qr-debt-first')
    const first = (await command('operations','debts.list',{status:'all'})).rows[0]
    await command('operations','sale.confirm',{...data,customer_id:first.customer_id},'qr-debt-second')
    const debts = (await command('operations','debts.list',{status:'all'})).rows
    return { debts, session:bootstrap.session, methods:bootstrap.methods }
  })
}
async function imageReady(page: Page, name: string) {
  const image = page.getByRole('img',{name:`Código QR ${name}`,exact:true})
  await expect(image).toBeVisible()
  await expect.poll(()=>image.evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}
for (const role of ['admin','cashier'] as const) {
  test(`${role}: QR en abono conserva valor, exige confirmación y sólo paga la deuda elegida`, async ({page,context}) => {
    await mockAuth(context,{profile:{id:authUser.id,display_name:'Empleado QR',role,active:true}})
    const seeded=await seedDebts(page)
    await page.reload()
    await page.locator('tbody tr').first().getByRole('button',{name:'Ver deuda de Cliente QR compartido'}).click()
    const amount=page.getByLabel('Valor del abono',{exact:true})
    const confirmation=page.getByRole('checkbox',{name:'Confirmo el valor recibido.',exact:true})
    const submit=page.getByRole('button',{name:'Registrar abono recibido',exact:true})
    await amount.fill('500')
    await expect(submit).toBeDisabled()
    await page.getByRole('combobox',{name:'Método',exact:true}).selectOption({label:'Transferencia'})
    await imageReady(page,'Nequi')
    await page.getByLabel('QR de transferencia',{exact:true}).selectOption('breb')
    await imageReady(page,'Llaves Bre-B')
    await expect(amount).toHaveValue('500')
    await expect(submit).toBeDisabled()
    await confirmation.check()
    await page.getByRole('combobox',{name:'Método',exact:true}).selectOption({label:'Efectivo'})
    await expect(page.getByLabel('QR de transferencia',{exact:true})).toHaveCount(0)
    await expect(confirmation).not.toBeChecked()
    await expect(amount).toHaveValue('500')
    await page.getByRole('combobox',{name:'Método',exact:true}).selectOption({label:'Transferencia'})
    await imageReady(page,'Nequi')
    await expect(page.locator('input[name="reference"]')).toHaveCount(0)
    await page.setViewportSize({width:390,height:844})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy()
    await confirmation.check()
    const requestPromise=page.waitForRequest(r=>r.url().endsWith('/api/operations')&&r.postDataJSON()?.action==='debt.receipt')
    await submit.evaluate((button:HTMLButtonElement)=>{button.click();button.click()})
    const request=await requestPromise
    await expect(page.getByText('Abono registrado en esta compra.',{exact:true})).toBeVisible()
    const result=await page.evaluate(async ({body,debts})=>{
      const call=async (payload:object) => {
        const r=await fetch('https://cai-api-test.invalid/api/operations',{method:'POST',headers:{Authorization:'Bearer fake.payload.signature','Content-Type':'application/json'},body:JSON.stringify(payload)})
        return {status:r.status,data:await r.json()}
      }
      const replay=await call(body)
      const details=[]
      for(const debt of debts) details.push((await call({action:'debt.detail',data:{charge_id:debt.charge_id}})).data)
      const excessive=await call({...body,key:'qr-overpayment',data:{...body.data,amount:'999999999'}})
      const bootstrap=(await call({action:'bootstrap',data:{}})).data
      return {replay,details,excessive,bootstrap}
    },{body:request.postDataJSON(),debts:seeded.debts})
    expect(result.replay.status).toBe(200)
    expect(Number(result.details[0].outstanding)).toBe(Number(seeded.debts[0].outstanding)-500)
    expect(result.details[1].outstanding).toBe(seeded.debts[1].outstanding)
    expect(result.details[0].receipts).toHaveLength(1)
    expect(result.details[0].receipts[0]).toMatchObject({method:'Transferencia',reference:null})
    expect(result.details[1].receipts).toHaveLength(0)
    expect(result.excessive.status).toBe(422)
    expect(result.bootstrap.session.expected).toBe(seeded.session.expected)
    expect(request.postDataJSON().data).not.toHaveProperty('reference')
  })
}
test('QR reemplazado en configuración se actualiza en abonos abiertos sin perder importe y vuelve a ventas',async({page,context})=>{
  await mockAuth(context)
  await seedDebts(page);await page.reload()
  await page.locator('tbody tr').first().getByRole('button').click()
  await page.getByLabel('Valor del abono',{exact:true}).fill('500')
  await page.getByRole('combobox',{name:'Método',exact:true}).selectOption({label:'Transferencia'})
  await imageReady(page,'Nequi')
  await page.getByRole('checkbox',{name:'Confirmo el valor recibido.',exact:true}).check()
  const initial=await page.getByRole('img',{name:'Código QR Nequi',exact:true}).getAttribute('src')
  const settings=await context.newPage();await settings.goto('/#/configuracion');await settings.getByRole('button',{name:'Ventas Métodos de pago y QR de transferencia'}).click()
  await settings.getByLabel('Reemplazar QR Nequi',{exact:true}).setInputFiles('tests/fixtures/qr-demo.jpg')
  await settings.getByRole('button',{name:'Guardar QR Nequi',exact:true}).click()
  await expect(page.getByRole('img',{name:'Código QR Nequi',exact:true})).not.toHaveAttribute('src',initial!)
  await imageReady(page,'Nequi')
  await expect(page.getByLabel('Valor del abono',{exact:true})).toHaveValue('500')
  await expect(page.getByRole('checkbox',{name:'Confirmo el valor recibido.',exact:true})).not.toBeChecked()
  await settings.close()
  await page.goto('/#/pos')
  await page.getByRole('button',{name:/Agregar Arroz/}).first().click()
  await page.getByLabel('Pago Transferencia',{exact:true}).fill('5800')
  await imageReady(page,'Nequi')
  await page.getByRole('button',{name:'Actualizar QR',exact:true}).click()
  await page.getByRole('checkbox',{name:/Confirmo los pagos recibidos/}).check()
  await expect(page.getByRole('button',{name:'Registrar venta',exact:true})).toBeEnabled()
})
