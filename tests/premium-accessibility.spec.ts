import { test, expect } from './fixtures/auth'

// Browser → existing Worker → isolated PGlite. No production requests or resets.
test('premium · menú móvil conserva foco, teclado y navegación', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/pos')
  await expect(page.getByRole('heading', { name: 'Punto de venta', exact: true })).toBeVisible()
  const open = page.getByRole('button', { name: 'Abrir menú', exact: true })
  await open.click()
  await expect(open).toHaveAttribute('aria-expanded', 'true')
  await expect(open).toHaveAttribute('aria-controls', 'main-navigation')
  const sidebar = page.locator('#main-navigation')
  await expect(sidebar.getByRole('link', { name: 'Inventario', exact: true })).toBeVisible()
  // Tabbing across the complete drawer must not land behind it.
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press('Tab')
    expect(await sidebar.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(open).toBeFocused()
  await expect(open).toHaveAttribute('aria-expanded', 'false')
  await open.click()
  await sidebar.getByRole('link', { name: 'Inventario', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Inventario', exact: true })).toBeVisible()
  await expect(open).toHaveAttribute('aria-expanded', 'false')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('premium · ayuda móvil cierra el menú y permite operar su panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/pos')
  await expect(page.getByRole('heading', { name: 'Punto de venta', exact: true })).toBeVisible()
  const open = page.getByRole('button', { name: 'Abrir menú', exact: true })
  await open.click()
  await page.locator('#main-navigation').getByRole('button', { name: 'Centro de ayuda', exact: true }).click()
  await expect(open).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.sidebar-backdrop')).toHaveCount(0)
  const information = page.getByRole('region', { name: 'Información', exact: true })
  await expect(information.getByRole('heading', { name: 'Centro de ayuda', exact: true })).toBeVisible()
  await information.getByRole('button', { name: 'Cerrar información', exact: true }).click()
  await expect(information).toHaveCount(0)
})

test('premium · menú compacto mantiene nombres y ruta activa', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#/inventario')
  await page.getByRole('button', { name: 'Contraer menú', exact: true }).click()
  const inventory = page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('link', { name: 'Inventario', exact: true })
  await expect(inventory).toHaveAttribute('aria-current', 'page')
  await expect(inventory).toHaveAttribute('title', 'Inventario')
  await inventory.focus()
  await expect(inventory).toBeFocused()
  const compactWidth = await page.locator('#main-navigation').evaluate(element => element.getBoundingClientRect().width)
  expect(compactWidth).toBeLessThanOrEqual(100)
  await page.getByRole('button', { name: 'Expandir menú', exact: true }).click()
  expect(await page.locator('#main-navigation').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(compactWidth)
  await expect(page.getByRole('button', { name: 'Contraer menú', exact: true })).toBeVisible()
})

test('premium · búsqueda de módulos funciona con teclado y conserva foco visible', async ({ page }) => {
  await page.goto('/#/pos')
  await expect(page.getByRole('heading', { name: 'Punto de venta', exact: true })).toBeVisible()
  await page.keyboard.press('Control+k')
  const search = page.getByRole('textbox', { name: 'Buscar módulos', exact: true })
  await expect(search).toBeFocused()
  await search.fill('inventario')
  const result = page.locator('.search-results').getByRole('link', { name: 'Inventario', exact: true })
  await page.keyboard.press('Tab')
  await expect(result).toBeFocused()
  expect(await result.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Inventario', exact: true })).toBeVisible()
  await expect(search).toHaveValue('')
})

test.describe('premium · interacción táctil', () => {
  test.use({ hasTouch: true })
  test('la explicación de indicadores abre con toque y cierra con Escape', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/#/estadisticas')
    const information = page.getByRole('button', { name: 'Información sobre Dinero recibido', exact: true })
    await information.tap()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toContainText('abonos')
    const bounds = await tooltip.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    await expect(information).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string)
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
  })
})

test('premium · tooltip permanece abierto al mover el puntero al contenido', async ({ page }) => {
  await page.goto('/#/estadisticas')
  const information = page.getByRole('button', { name: 'Información sobre Dinero recibido', exact: true })
  await expect(information).toBeVisible()
  await page.clock.install()
  await information.hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toContainText('abonos')
  await tooltip.hover()
  // Advance beyond the pointer gap's close delay: the popup is hovered now.
  await page.clock.fastForward(500)
  await expect(tooltip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
})

test('premium · tabla móvil accesible y movimiento reducido', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/#/inventario')
  await expect(page.getByText('Cargando información…', { exact: true })).toHaveCount(0)
  const tableRegion = page.locator('.table-scroll').filter({ has: page.getByRole('table') }).first()
  await expect(tableRegion).toHaveAttribute('tabindex', '0')
  await tableRegion.focus()
  await expect(tableRegion).toBeFocused()
  const overflow = await tableRegion.evaluate(element => ({
    scrollable: element.scrollWidth > element.clientWidth,
    overflow: getComputedStyle(element).overflowX,
  }))
  expect(overflow.scrollable).toBe(true)
  expect(['auto', 'scroll']).toContain(overflow.overflow)
  for (let index = 0; index < 10; index++) await page.keyboard.press('ArrowRight')
  await expect.poll(() => tableRegion.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Abrir menú', exact: true }).click()
  const duration = await page.locator('#main-navigation').evaluate(element =>
    Math.max(...getComputedStyle(element).transitionDuration.split(',').map(value => Number.parseFloat(value))))
  expect(duration).toBeLessThanOrEqual(0.01)
})

test('premium · diálogo devuelve el foco y no guarda al cancelar', async ({ page }) => {
  await page.goto('/#/inventario')
  const trigger = page.getByRole('button', { name: 'Nuevo producto', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await dialog.getByLabel('Nombre', { exact: true }).fill('Borrador visual no guardado')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await page.getByLabel('Buscar productos', { exact: true }).fill('Borrador visual no guardado')
  await expect(page.getByText('No hay resultados para esta búsqueda.', { exact: true })).toBeVisible()
})

test('premium · contraste de tokens y botón principal en ambos temas', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cai-market:theme:v1', 'light'))
  await page.goto('/#/inventario')
  await expect(page.getByRole('button', { name: 'Nuevo producto', exact: true })).toBeVisible()
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Modo oscuro', exact: true }).click()
    const results = await page.evaluate(() => {
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      const ratio = (foreground: string, background: string) => {
        const first = luminance(foreground), second = luminance(background)
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
      }
      const measurements: { name: string; contrast: number }[] = []
      const probe = document.createElement('span')
      probe.hidden = true
      document.body.append(probe)
      for (const background of ['--surface', '--background', '--surface-soft']) {
        for (const foreground of ['--foreground', '--muted']) {
          probe.style.color = `var(${foreground})`
          probe.style.backgroundColor = `var(${background})`
          const computed = getComputedStyle(probe)
          measurements.push({ name: `${foreground} / ${background}`, contrast: ratio(computed.color, computed.backgroundColor) })
        }
      }
      probe.remove()
      const button = getComputedStyle(document.querySelector('.page-heading .button-primary')!)
      measurements.push({ name: 'Acción principal', contrast: ratio(button.color, button.backgroundColor) })
      return measurements
    })
    for (const measurement of results) expect(measurement.contrast, `${theme}: ${measurement.name}`).toBeGreaterThanOrEqual(4.5)
  }
})
