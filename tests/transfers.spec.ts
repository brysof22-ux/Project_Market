import { test, expect, type Page } from './fixtures/auth'
import path from 'node:path'

async function openSale(page: Page) {
  await page.goto('/#/pos')
  await page
    .getByRole('button', { name: 'Agregar Café de origen 500 g', exact: true })
    .click()
  await expect(page.getByLabel('Método de pago de ejemplo')).toBeEnabled()
}
async function selectTransfer(page: Page) {
  await page
    .getByLabel('Método de pago de ejemplo')
    .selectOption('Transferencia')
  await expect(
    page.getByRole('dialog', { name: 'Pago por transferencia' }),
  ).toBeVisible()
  await expect(page.getByRole('img', { name: /QR fijo de/ })).toBeVisible()
}
async function verifyTransfer(page: Page, reference = 'TR-DEMO-001') {
  await page.getByLabel('Referencia bancaria').fill(reference)
  await page.getByRole('checkbox', { name: /He verificado el ingreso/ }).check()
  await page
    .getByRole('button', { name: 'Confirmar pago recibido', exact: true })
    .click()
  await expect(
    page.getByRole('dialog', { name: 'Pago por transferencia' }),
  ).toHaveCount(0)
}
async function addQr(page: Page, name: string, file: string) {
  await page.getByRole('button', { name: 'Agregar QR', exact: true }).click()
  await page.getByLabel('Nombre del QR').fill(name)
  await page
    .getByLabel('Entidad financiera o billetera')
    .fill('Entidad de pruebas')
  await page.getByLabel('Nombre del titular').fill('Titular de ejemplo')
  await page
    .getByLabel('Imagen QR', { exact: true })
    .setInputFiles(path.resolve(file))
  await expect(
    page.getByRole('img', { name: 'Vista previa del QR cargado' }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Guardar método', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test('selección automática, QR fijo, importe exacto, ampliación, referencia y confirmación manual', async ({
  page,
}) => {
  await openSale(page)
  await expect(
    page.getByLabel('Método de pago de ejemplo').locator('option'),
  ).toHaveText([
    'Efectivo',
    'Transferencia',
    'Tarjeta',
    'Crédito',
    'Pago mixto',
  ])
  await selectTransfer(page)
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.transfer-amount')).toContainText('28.500,00')
  await expect(dialog).toContainText('Banco de ejemplo')
  await expect(
    page.getByRole('button', { name: 'Confirmar pago recibido', exact: true }),
  ).toBeDisabled()
  await page.getByLabel('Referencia bancaria').fill('REFERENCIA-NO-ES-PRUEBA')
  await expect(
    page.getByRole('button', { name: 'Confirmar pago recibido', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Ampliar QR', exact: true }).click()
  await expect(dialog.getByRole('img')).toHaveClass(/qr-enlarged/)
  await page.getByRole('button', { name: 'Reducir QR', exact: true }).click()
  await page
    .getByRole('dialog')
    .screenshot({ path: 'test-results/transfer-modal-desktop.png' })
  await verifyTransfer(page)
  await expect(page.locator('.payment-history tbody tr')).toHaveCount(0)
  await page.getByRole('button', { name: 'Simular venta', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Simulación completada' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Iniciar otra simulación' }).click()
  const row = page.locator('.payment-history tbody tr')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('TR-DEMO-001')
  await expect(row).toContainText('Daniel Gómez')
  await expect(row).toContainText('Manual · Demo')
  await expect(
    page.locator('.payment-summary').getByText('$ 0,00', { exact: true }),
  ).toHaveCount(2)
  await page.reload()
  await expect(page.locator('.payment-history tbody tr')).toHaveCount(1)
  await page.goto('/#/contabilidad')
  await expect(page.locator('.payment-history tbody tr')).toContainText(
    'TR-DEMO-001',
  )
})

test('cambiar QR borra referencia y verificación; cancelar no registra ni habilita la venta', async ({
  page,
}) => {
  await openSale(page)
  await selectTransfer(page)
  await page.getByLabel('Referencia bancaria').fill('NO-GUARDAR')
  await page.getByRole('checkbox', { name: /He verificado el ingreso/ }).check()
  await page
    .getByRole('combobox', { name: 'QR para la transferencia' })
    .selectOption('wallet-demo')
  await expect(page.getByRole('dialog')).toContainText('Billetera de ejemplo')
  await expect(
    page.getByRole('img', { name: 'QR fijo de Billetera · Demo' }),
  ).toHaveAttribute('src', '/demo-qr/billetera-demo.png')
  await expect(page.getByLabel('Referencia bancaria')).toHaveValue('')
  await expect(
    page.getByRole('checkbox', { name: /He verificado el ingreso/ }),
  ).not.toBeChecked()
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('Método de pago de ejemplo')).toBeFocused()
  await expect(
    page.getByRole('button', { name: 'Simular venta', exact: true }),
  ).toBeDisabled()
  await expect(page.locator('.payment-history tbody tr')).toHaveCount(0)
})

test('cambiar el carrito invalida una confirmación anterior', async ({
  page,
}) => {
  await openSale(page)
  await selectTransfer(page)
  await verifyTransfer(page)
  await expect(
    page.getByRole('button', { name: 'Simular venta', exact: true }),
  ).toBeEnabled()
  await page
    .getByRole('button', { name: 'Sumar una unidad de Café de origen 500 g' })
    .click()
  await expect(
    page.getByRole('button', { name: 'Simular venta', exact: true }),
  ).toBeDisabled()
  await page
    .getByRole('button', {
      name: 'Ver QR y confirmar transferencia',
      exact: true,
    })
    .click()
  await expect(page.locator('.transfer-amount')).toContainText('57.000,00')
})

test('pago mixto conserva centavos exactos y separa transferencia de efectivo', async ({
  page,
}) => {
  await openSale(page)
  await page.getByLabel('Método de pago de ejemplo').selectOption('Pago mixto')
  await page.getByLabel('Efectivo en pago mixto').fill('10000.25')
  await page.getByLabel('Transferencia en pago mixto').fill('18499.75')
  await page
    .getByRole('button', {
      name: 'Ver QR y confirmar transferencia',
      exact: true,
    })
    .click()
  await expect(page.locator('.transfer-amount')).toContainText('18.499,75')
  await verifyTransfer(page, 'MIXTO-01')
  await page.getByRole('button', { name: 'Simular venta', exact: true }).click()
  await page.getByRole('button', { name: 'Iniciar otra simulación' }).click()
  await expect(page.locator('.payment-history tbody tr')).toHaveCount(2)
  await expect(page.locator('.payment-summary')).toContainText('10.000,25')
  await expect(page.locator('.payment-summary')).toContainText('18.499,75')
})

test('administrador carga PNG, JPG y WebP, cambia el QR y conserva configuración al recargar', async ({
  page,
}) => {
  await page.goto('/#/configuracion')
  await addQr(page, 'QR PNG de pruebas', 'public/demo-qr/banco-demo.png')
  await addQr(page, 'QR JPG de pruebas', 'tests/fixtures/qr-demo.jpg')
  await addQr(page, 'QR WebP de pruebas', 'tests/fixtures/qr-demo.webp')
  await page.reload()
  const card = page
    .locator('.transfer-method-card')
    .filter({
      has: page.getByRole('heading', {
        name: 'QR PNG de pruebas',
        exact: true,
      }),
    })
  await card.getByRole('button', { name: 'Editar QR', exact: true }).click()
  await page
    .getByLabel('Imagen QR', { exact: true })
    .setInputFiles(path.resolve('public/demo-qr/billetera-demo.png'))
  await expect(
    page.getByRole('img', { name: 'Vista previa del QR cargado' }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Guardar método', exact: true })
    .click()
  await expect(card).toContainText('Versión 2')
  await openSale(page)
  await selectTransfer(page)
  await page
    .getByRole('combobox', { name: 'QR para la transferencia' })
    .selectOption({ label: 'QR PNG de pruebas' })
  await expect(
    page.getByRole('img', { name: 'QR fijo de QR PNG de pruebas' }),
  ).toHaveAttribute('src', /^blob:/)
  await expect(page.getByRole('dialog')).toContainText('Entidad de pruebas')
})

test('formatos falsificados, SVG y tamaño excesivo se rechazan', async ({
  page,
}) => {
  await page.goto('/#/configuracion')
  await page.getByRole('button', { name: 'Agregar QR', exact: true }).click()
  const fileInput = page.getByLabel('Imagen QR', { exact: true })
  await fileInput.setInputFiles({
    name: 'malicioso.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
  })
  await expect(page.getByRole('alert')).toContainText('no coincide')
  await fileInput.setInputFiles({
    name: 'qr.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg/>'),
  })
  await expect(page.getByRole('alert')).toContainText('únicamente')
  await fileInput.setInputFiles({
    name: 'grande.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
  })
  await expect(page.getByRole('alert')).toContainText('2 MB')
  await expect(
    page.getByRole('button', { name: 'Guardar método', exact: true }),
  ).toBeDisabled()
})

for (const role of ['Cajero', 'Supervisor']) {
  test(`${role} ve QR pero no puede modificarlos`, async ({ page }) => {
    await page.goto('/#/configuracion')
    await page.getByLabel('Rol de demostración').selectOption({ label: role })
    await expect(
      page.getByText('Solo lectura:', { exact: false }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Agregar QR', exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Editar QR', exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Desactivar', exact: true }),
    ).toHaveCount(0)
    await page.reload()
    await expect(page.getByLabel('Rol de demostración')).toHaveValue(
      role === 'Cajero' ? 'cashier' : 'supervisor',
    )
    await openSale(page)
    await selectTransfer(page)
    await verifyTransfer(page, 'ROL-01')
    await page
      .getByRole('button', { name: 'Simular venta', exact: true })
      .click()
    await page.getByRole('button', { name: 'Iniciar otra simulación' }).click()
    await expect(page.locator('.payment-history tbody')).toContainText(
      `${role} de ejemplo`,
    )
  })
}

test('métodos desactivados no se ofrecen y ausencia de QR bloquea transferencias', async ({
  page,
}) => {
  await page.goto('/#/configuracion')
  await expect(
    page.getByRole('button', { name: 'Desactivar', exact: true }),
  ).toHaveCount(2)
  await page
    .getByRole('button', { name: 'Desactivar', exact: true })
    .first()
    .click()
  await expect(
    page.getByRole('button', { name: 'Desactivar', exact: true }),
  ).toHaveCount(1)
  await page.getByRole('button', { name: 'Desactivar', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Activar', exact: true }),
  ).toHaveCount(2)
  await openSale(page)
  await page
    .getByLabel('Método de pago de ejemplo')
    .selectOption('Transferencia')
  await expect(page.getByRole('dialog')).toContainText('No hay QR activos')
  await expect(
    page.getByRole('button', { name: 'Confirmar pago recibido', exact: true }),
  ).toBeDisabled()
})

test('QR y controles funcionan en móvil sin desbordamiento', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openSale(page)
  await selectTransfer(page)
  await page.getByRole('button', { name: 'Ampliar QR', exact: true }).click()
  expect(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true)
  await page
    .getByRole('dialog')
    .screenshot({ path: 'test-results/transfer-modal-mobile.png' })
  await verifyTransfer(page, 'MOVIL-01')
  await page.getByRole('button', { name: 'Simular venta', exact: true }).click()
  await page.getByRole('button', { name: 'Iniciar otra simulación' }).click()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/transfer-mobile.png',
    fullPage: true,
  })
})

test('un QR desactivado en otra pestaña invalida una confirmación pendiente', async ({
  page,
  context,
}) => {
  await openSale(page)
  await selectTransfer(page)
  await verifyTransfer(page)
  const admin = await context.newPage()
  await admin.goto('/#/configuracion')
  await admin
    .locator('.transfer-method-card')
    .filter({
      has: admin.getByRole('heading', {
        name: 'Banco principal · Demo',
        exact: true,
      }),
    })
    .getByRole('button', { name: 'Desactivar', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Simular venta', exact: true }),
  ).toBeDisabled()
  await expect(page.locator('.payment-history tbody tr')).toHaveCount(0)
  await page
    .getByRole('button', {
      name: 'Ver QR y confirmar transferencia',
      exact: true,
    })
    .click()
  await expect(page.getByRole('dialog')).toContainText('Billetera de ejemplo')
  await admin.close()
})

test('dos clics rápidos no duplican la venta ni el historial', async ({
  page,
}) => {
  await openSale(page)
  await selectTransfer(page)
  await verifyTransfer(page, 'DOBLE-CLIC-01')
  await page
    .getByRole('button', { name: 'Simular venta', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
  await expect(
    page.getByRole('dialog', { name: 'Simulación completada' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Iniciar otra simulación' }).click()
  await expect(page.locator('.payment-history tbody tr')).toHaveCount(1)
})

test('la capa local rechaza escrituras de un cajero, además de ocultar los controles', async ({
  page,
}) => {
  await page.goto('/#/configuracion')
  await expect(
    page.getByRole('button', { name: 'Editar QR', exact: true }),
  ).toHaveCount(2)
  const message = await page.evaluate(async () => {
    const modulePath = '/src/features/payments/repository.ts'
    const repository = await import(modulePath)
    const [method] = await repository.listTransferMethods()
    try {
      await repository.saveTransferMethod(
        { id: 'cashier-test', name: 'Cajero', role: 'cashier' },
        {
          ...method,
          name: 'Cambio prohibido',
          expectedRevision: method.revision,
        },
      )
      return 'Unexpected write'
    } catch (error) {
      return (error as Error).message
    }
  })
  expect(message).toContain('Solo el administrador')
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Cambio prohibido', exact: true }),
  ).toHaveCount(0)
})
