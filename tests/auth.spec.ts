import { test, expect, type Page } from '@playwright/test'
import { authUser, fakeSession, mockAuth, storageKey } from './fixtures/auth'

async function login(page: Page) {
  await page.getByLabel('Correo electrónico').fill(authUser.email)
  await page.getByLabel('Contraseña', { exact: true }).fill('test-password-not-real')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
}
const dashboard = (page: Page) => page.getByRole('heading', { name: 'Tu negocio, de un vistazo' })
const loginHeading = (page: Page) => page.getByRole('heading', { name: 'Bienvenido a tu tienda' })

test('rutas privadas ocultas sin sesión y enlace profundo conservado al iniciar', async ({ page, context }) => {
  const calls = await mockAuth(context)
  await page.goto('/#/inventario')
  await expect(loginHeading(page)).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await login(page)
  await expect(page.getByRole('heading', { name: 'Inventario', exact: true })).toBeVisible()
  expect(calls.some((call) => call.includes('grant_type=password'))).toBe(true)
  expect(calls.some((call) => call.includes('user'))).toBe(true)
  expect(calls.some((call) => call.includes('/rest/'))).toBe(false)
})

test('error de credenciales, validación, contraseña visible y recuperación', async ({ page, context }) => {
  const options = { passwordError: true }
  const calls = await mockAuth(context, options)
  await page.goto('/')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  expect(calls.some((call) => call.includes('token'))).toBe(false)
  await page.getByRole('button', { name: 'Mostrar contraseña' }).click()
  await expect(page.getByLabel('Contraseña', { exact: true })).toHaveAttribute('type', 'text')
  await login(page)
  await expect(page.getByRole('alert')).toContainText('Correo o contraseña incorrectos')
  await expect(dashboard(page)).toHaveCount(0)
  options.passwordError = false
  await login(page)
  await expect(dashboard(page)).toBeVisible()
})

test('sesión persistente al recargar y cierre local con protección posterior', async ({ page, context }) => {
  const calls = await mockAuth(context)
  await page.goto('/')
  await login(page)
  await expect(dashboard(page)).toBeVisible()
  await page.reload()
  await expect(dashboard(page)).toBeVisible()
  await page.getByRole('button', { name: 'Perfil de usuario' }).click()
  await expect(page.getByRole('region', { name: 'Información' })).toContainText(authUser.email)
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()
  await expect(loginHeading(page)).toBeVisible()
  await page.reload()
  await expect(loginHeading(page)).toBeVisible()
  await page.goto('/#/pos')
  await expect(page.getByRole('navigation')).toHaveCount(0)
  expect(calls.some((call) => call.includes('logout?scope=local'))).toBe(true)
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull()
})

for (const refreshError of [false, true]) {
  test(`sesión expirada: ${refreshError ? 'refresh revocado vuelve al acceso' : 'renovación válida conserva acceso'}`, async ({ page, context }) => {
    const calls = await mockAuth(context, { refreshError })
    await page.goto('/')
    await login(page)
    await expect(dashboard(page)).toBeVisible()
    await page.evaluate((key) => {
      const session = JSON.parse(localStorage.getItem(key)!)
      session.expires_at = 1
      localStorage.setItem(key, JSON.stringify(session))
    }, storageKey)
    await page.reload()
    await expect(refreshError ? loginHeading(page) : dashboard(page)).toBeVisible()
    expect(calls.some((call) => call.includes('grant_type=refresh_token'))).toBe(true)
  })
}

test('una sesión almacenada que Auth rechaza no revela módulos', async ({ page, context }) => {
  const options = { userError: false }
  await mockAuth(context, options)
  await page.goto('/')
  await login(page)
  await expect(dashboard(page)).toBeVisible()
  options.userError = true
  await page.reload()
  await expect(loginHeading(page)).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Tu sesión ya no es válida')
  await expect(page.getByRole('navigation')).toHaveCount(0)
})

test('cierre se sincroniza entre pestañas', async ({ page, context }) => {
  await mockAuth(context)
  await page.goto('/')
  await login(page)
  await expect(dashboard(page)).toBeVisible()
  const other = await context.newPage()
  await other.goto('/#/pos')
  await expect(other.getByRole('navigation')).toBeVisible()
  await page.getByRole('button', { name: 'Perfil de usuario' }).click()
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()
  await expect(loginHeading(other)).toBeVisible()
  await other.close()
})

test('cierre con error de servidor no deja acceso privado local', async ({ page, context }) => {
  await mockAuth(context, { logoutError: true })
  await page.goto('/')
  await login(page)
  await expect(dashboard(page)).toBeVisible()
  await page.getByRole('button', { name: 'Perfil de usuario' }).click()
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()
  await expect(loginHeading(page)).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('No pudimos confirmar el cierre')
  await page.reload()
  await expect(loginHeading(page)).toBeVisible()
})

test('login móvil, modo oscuro y ausencia de desbordamiento', async ({ page, context }) => {
  await mockAuth(context)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(loginHeading(page)).toBeVisible()
  await page.getByRole('button', { name: 'Cambiar a modo oscuro' }).click()
  await expect(page.locator('html')).toHaveClass('dark')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/login-mobile-dark.png', fullPage: true })
})

test('inicio pendiente bloquea envíos duplicados y no muestra vistas privadas', async ({ page, context }) => {
  await mockAuth(context)
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let requests = 0
  await context.route('**/auth/v1/token?grant_type=password', async (route) => {
    requests++
    await pending
    await route.fulfill({ json: fakeSession() })
  })
  await page.goto('/')
  await page.getByLabel('Correo electrónico').fill(authUser.email)
  await page.getByLabel('Contraseña', { exact: true }).fill('test-password-not-real')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
  try {
    await expect(page.getByRole('button', { name: 'Iniciando sesión…' })).toBeDisabled()
    await expect(page.getByRole('navigation')).toHaveCount(0)
    await expect.poll(() => requests).toBe(1)
  } finally { release() }
  await expect(dashboard(page)).toBeVisible()
})

test('expiración durante el uso sin renovación válida oculta las rutas privadas', async ({ page, context }) => {
  const options = { refreshError: false }
  await mockAuth(context, options)
  await page.clock.install()
  await page.goto('/')
  await login(page)
  await expect(dashboard(page)).toBeVisible()
  options.refreshError = true
  await page.clock.fastForward(3_601_000)
  await expect(loginHeading(page)).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
})

for (const status of [401, 403, 503]) {
  test(`perfil API ${status} bloquea módulos con un mensaje claro`, async ({ page, context }) => {
    await mockAuth(context, { profileStatus: status })
    await page.goto('/')
    await login(page)
    await expect(page.getByRole('alert')).toContainText(status === 401 ? 'sesión ya no es válida' : status === 403 ? 'No tienes un perfil activo' : 'servicio de perfiles no está disponible')
    await expect(page.getByRole('navigation')).toHaveCount(0)
  })
}

test('perfil API de otra persona no concede acceso', async ({ page, context }) => {
  await mockAuth(context, { profile: { id: '10000000-0000-0000-0000-000000000002', display_name: 'Otro usuario', role: 'admin', active: true } })
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('alert')).toContainText('sesión ya no es válida')
  await expect(page.getByRole('navigation')).toHaveCount(0)
})
