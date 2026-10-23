import { test, expect } from './fixtures/auth'

test('navegación de los ocho módulos y búsqueda global', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Tu negocio, de un vistazo' }),
  ).toBeVisible()
  for (const title of [
    'Punto de venta',
    'Inventario',
    'Estadísticas',
    'Contabilidad',
    'Clientes',
    'Proveedores',
    'Configuración',
  ]) {
    await page
      .getByRole('navigation')
      .getByRole('link', { name: title, exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible()
    await expect(
      page
        .getByRole('navigation')
        .getByRole('link', { name: title, exact: true }),
    ).toHaveAttribute('aria-current', 'page')
  }
  await page.getByRole('textbox', { name: 'Buscar módulos' }).fill('inven')
  await page
    .locator('.search-results')
    .getByRole('link', { name: 'Inventario' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Inventario', exact: true }),
  ).toBeVisible()
  await page.goBack()
  await expect(
    page.getByRole('heading', { name: 'Configuración', exact: true }),
  ).toBeVisible()
  const skipLink = page.getByRole('link', { name: 'Saltar al contenido' })
  await skipLink.focus()
  await skipLink.press('Enter')
  await expect(page.locator('#main')).toBeFocused()
  await expect(page).toHaveURL(/#\/configuracion$/)
  expect(errors).toEqual([])
})

test('filtros de inventario y estados vacíos', async ({ page }) => {
  await page.goto('/#/inventario')
  await expect(page.locator('tbody tr')).toHaveCount(8)
  await page.getByRole('checkbox', { name: 'Solo stock bajo' }).check()
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await page.getByRole('textbox', { name: 'Buscar productos' }).fill('café')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page
    .getByRole('textbox', { name: 'Buscar productos' })
    .fill('inexistente')
  await expect(
    page.getByText('No hay resultados para esta búsqueda.'),
  ).toBeVisible()
})

test('carrito, límite de stock y simulación sin persistir ventas', async ({
  page,
}) => {
  await page.goto('/#/pos')
  await expect(
    page.getByRole('button', { name: 'Simular venta', exact: true }),
  ).toBeDisabled()
  for (let i = 0; i < 8; i++)
    await page
      .getByRole('button', {
        name: 'Agregar Café de origen 500 g',
        exact: true,
      })
      .click()
  await expect(
    page.getByRole('button', {
      name: 'Agregar Café de origen 500 g',
      exact: true,
    }),
  ).toBeDisabled()
  await expect(page.locator('.cart-total')).toContainText('228.000')
  await page
    .getByRole('button', { name: 'Quitar una unidad de Café de origen 500 g' })
    .click()
  await expect(page.locator('.cart-total')).toContainText('199.500')
  await page.getByRole('button', { name: 'Simular venta', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(
    'No se ha realizado ningún cobro',
  )
  await page.getByRole('button', { name: 'Iniciar otra simulación' }).click()
  await expect(
    page.getByRole('button', { name: 'Simular venta', exact: true }),
  ).toBeDisabled()
  await page.goto('/#/inventario')
  await expect(
    page.locator('tbody tr').filter({ hasText: 'CAF-001' }),
  ).toContainText('8 unidades')
})

test('detalle de venta, filtro contable, CSV y períodos de gráfica', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Ver venta V-00842' }).click()
  await expect(page.getByRole('dialog')).toContainText('María García')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Este mes', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Este mes', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Exportar reporte' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Descargar CSV simulado' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('ventas-simuladas-2026-10-23.csv')
  await page.getByRole('link', { name: 'Ver todas', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Estado de venta' })
    .selectOption('Pendiente')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody')).toContainText('Ana Martínez')
})

test('tema persistente y validación de formulario sin almacenamiento', async ({
  page,
}) => {
  await page.goto('/#/configuracion')
  await page.getByRole('button', { name: 'Cambiar a modo oscuro' }).click()
  await expect(page.locator('html')).toHaveClass('dark')
  await page.reload()
  await expect(page.locator('html')).toHaveClass('dark')
  await page.getByRole('textbox', { name: 'Nombre de la tienda' }).fill('   ')
  await page.getByRole('button', { name: 'Validar datos de prueba' }).click()
  await expect(page.getByRole('status')).toHaveCount(0)
  await page
    .getByRole('textbox', { name: 'Nombre de la tienda' })
    .fill('Tienda de prueba')
  await page.getByRole('button', { name: 'Validar datos de prueba' }).click()
  await expect(page.getByRole('status')).toContainText(
    'no se guardó información',
  )
})

for (const viewport of [
  { width: 390, height: 844 },
  { width: 834, height: 1112 },
]) {
  test(`responsive ${viewport.width}px sin desbordamiento y con navegación`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await expect(
      page.getByRole('heading', { name: 'Tu negocio, de un vistazo' }),
    ).toBeVisible()
    if (viewport.width < 760)
      await page.getByRole('button', { name: 'Abrir menú' }).click()
    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'Inventario', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: 'Inventario', exact: true }),
    ).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    await page.goto('/#/dashboard')
    await expect(
      page.getByRole('heading', { name: 'Tu negocio, de un vistazo' }),
    ).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    await page.screenshot({
      path: `test-results/dashboard-${viewport.width}.png`,
      fullPage: true,
    })
  })
}

test('capturas de escritorio y consola limpia', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/')
  await expect(page.locator('.recharts-area')).toHaveCount(2)
  await page.screenshot({
    path: 'test-results/dashboard-desktop.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Modo oscuro', exact: true }).click()
  await expect(page.locator('html')).toHaveClass('dark')
  await page.screenshot({
    path: 'test-results/dashboard-dark.png',
    fullPage: true,
  })
  expect(errors).toEqual([])
})
