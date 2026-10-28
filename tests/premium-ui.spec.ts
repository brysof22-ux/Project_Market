import { test, expect } from './fixtures/auth'

// All requests use the isolated business fixture (real Worker + PGlite).
// These journeys never connect to production or execute an administrative reset.
const phase = process.env.CAI_VISUAL_PHASE === 'before' ? 'before' : 'after'
const routes = ['pos', 'inventario', 'estadisticas', 'contabilidad', 'clientes', 'proveedores', 'creditos', 'auditoria', 'configuracion']

for (const width of [360, 834, 1280, 1440]) {
  test(`premium · recorridos visuales ${width}px`, async ({ page }) => {
    test.setTimeout(150_000)
    await page.setViewportSize({ width, height: 1000 })
    await page.addInitScript(() => localStorage.setItem('cai-market:theme:v1', 'light'))
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    for (const route of routes) {
      await page.goto(`/#/${route}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.getByText('Cargando información…', { exact: true })).toHaveCount(0)
      await expect(page.getByText('Comprobando período operativo…', { exact: true })).toHaveCount(0)
      await page.screenshot({ path: `.cache/premium/${phase}/${route}-${width}.png`, fullPage: true })
      if (phase === 'after') expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    expect(errors).toEqual([])
  })
}

test('premium · formularios, pagos y temas conservan sus controles', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => localStorage.setItem('cai-market:theme:v1', 'light'))
  await page.goto('/#/inventario')
  await page.getByRole('button', { name: 'Nuevo producto', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Nombre', { exact: true })).toBeVisible()
  await dialog.getByLabel('Nombre', { exact: true }).fill('Producto visual aislado')
  await dialog.getByLabel('Precio de venta').fill('100')
  await dialog.getByLabel('Cantidad a ingresar', { exact: true }).fill('3')
  await dialog.getByLabel('Precio total de compra', { exact: true }).fill('120')
  await page.screenshot({ path: `.cache/premium/${phase}/producto-formulario.png` })
  await dialog.getByRole('button', { name: 'Guardar producto', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.goto('/#/pos')
  await page.getByLabel('Buscar productos para venta').fill('Producto visual aislado')
  await page.getByRole('button', { name: 'Agregar Producto visual aislado', exact: true }).click()
  await page.getByLabel('Pago Transferencia', { exact: true }).fill('100')
  await expect(page.getByLabel('QR de transferencia', { exact: true })).toBeVisible()
  await page.screenshot({ path: `.cache/premium/${phase}/pos-transferencia.png`, fullPage: true })
  await expect(page.getByRole('button', { name: 'Registrar venta', exact: true })).toBeDisabled()
  await page.getByLabel('Pago Transferencia', { exact: true }).fill('0')
  await page.getByLabel('Pago Efectivo', { exact: true }).fill('100')
  await page.getByRole('checkbox', { name: /Confirmo los pagos recibidos/ }).check()
  await page.getByRole('button', { name: 'Registrar venta', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Venta registrada en la tienda.' })).toBeVisible()
  await page.goto('/#/estadisticas')
  const info = page.getByRole('button', { name: 'Información sobre Margen bruto', exact: true })
  await info.focus()
  await expect(page.getByRole('tooltip')).toContainText('60')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.getByRole('button', { name: 'Modo oscuro', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({ path: `.cache/premium/${phase}/estadisticas-dark.png`, fullPage: true })
})

for (const width of [390, 1440]) {
  test(`premium · paneles secundarios y formularios ${width}px`, async ({ page }) => {
    test.setTimeout(150_000)
    await page.setViewportSize({ width, height: 1000 })
    await page.addInitScript(() => localStorage.setItem('cai-market:theme:v1', 'light'))
    await page.goto('/#/configuracion')
    for (const [index, name] of ['Mi negocio', 'Ventas', 'Inventario', 'Caja y finanzas', 'WhatsApp', 'Usuarios y seguridad', 'Datos y mantenimiento'].entries()) {
      await page.getByRole('button', { name: new RegExp(`^${name} `) }).click()
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
      await expect(page.getByText('Cargando información…', { exact: true })).toHaveCount(0)
      if (name === 'Ventas') {
        await expect(page.getByRole('img', { name: 'Código QR Nequi', exact: true })).toBeVisible()
        await expect(page.getByRole('img', { name: 'Código QR Llaves Bre-B', exact: true })).toBeVisible()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `.cache/premium/${phase}/settings-${index}-${width}.png`, fullPage: true })
    }
    // Inspect the danger zone without preview, credentials or confirmation.
    await expect(page.getByLabel('Confirma tu contraseña', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Eliminar operación permanentemente', exact: true })).toHaveCount(0)
    await page.goto('/#/contabilidad')
    for (const [index, name] of ['Control de caja', 'Movimientos financieros', 'Historial de cajas', 'Resumen de ingresos y egresos'].entries()) {
      await page.getByRole('tab', { name, exact: true }).click()
      await expect(page.getByText('Cargando información…', { exact: true })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `.cache/premium/${phase}/accounting-${index}-${width}.png`, fullPage: true })
    }
    await page.goto('/#/inventario')
    await page.getByRole('button', { name: 'Nuevo producto', exact: true }).click()
    await expect(page.getByRole('dialog').getByLabel('Nombre', { exact: true })).toBeVisible()
    expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: `.cache/premium/${phase}/product-dialog-${width}.png` })
    await page.keyboard.press('Escape')
    await page.goto('/#/estadisticas')
    await page.locator('.financial-chart-details > summary').click()
    await expect(page.getByRole('img', { name: 'Evolución de ganancias', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `.cache/premium/${phase}/financial-expanded-${width}.png`, fullPage: true })
  })
}
