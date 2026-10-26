import { lazy, Suspense, useEffect, useState } from 'react'
import { Layout } from './components/layout'
import { navigation, type PageId } from './data/navigation'
import { useAuth } from './features/auth/context'
import { Login } from './features/auth/login'
import { canAccessRoute, homeRoute } from '../shared/permissions'
import { Button } from './components/ui/button'
import { OperationPeriod } from './features/operations/period'
const Dashboard = lazy(() =>
  import('./features/dashboard').then((module) => ({
    default: module.Dashboard,
  })),
)
const Inventory = lazy(() =>
  import('./features/inventory').then((module) => ({
    default: module.Inventory,
  })),
)
const PointOfSale = lazy(() =>
  import('./features/operations/pos').then((module) => ({ default: module.PointOfSale })),
)
const Accounting = lazy(() =>
  import('./features/operations/cash').then((module) => ({
    default: module.Accounting,
  })),
)
const Directory = lazy(() =>
  import('./features/catalog/directory').then((module) => ({
    default: module.Directory,
  })),
)
const Settings = lazy(() =>
  import('./features/operations/settings').then((module) => ({ default: module.Settings })),
)
const Statistics = lazy(() =>
  import('./features/dashboard').then((module) => ({
    default: module.Statistics,
  })),
)

const Credits = lazy(() => import('./features/operations/credits').then((module) => ({ default: module.Credits })))
const Audit = lazy(() => import('./features/operations/settings').then((module) => ({ default: module.Audit })))

function readPage(): PageId {
  const id = window.location.hash.replace('#/', '').split('?')[0]
  return navigation.find((item) => item.id === id)?.id ?? 'dashboard'
}
function readTheme() {
  try {
    return localStorage.getItem('cai-market:theme:v1') !== 'light'
  } catch {
    return true
  }
}
export default function App() {
  const { session, profile, loading, signOut } = useAuth()
  const [page, setPage] = useState<PageId>(readPage)
  const [dark, setDark] = useState(readTheme)
  useEffect(() => {
    function handleNavigation() {
      setPage(readPage())
      window.scrollTo({ top: 0 })
      document.getElementById('main')?.focus()
    }
    window.addEventListener('hashchange', handleNavigation)
    return () => window.removeEventListener('hashchange', handleNavigation)
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      localStorage.setItem('cai-market:theme:v1', dark ? 'dark' : 'light')
    } catch {
      /* Theme still works when storage is unavailable. */
    }
  }, [dark])
  const toggleTheme = () => setDark((previous) => !previous)
  if (loading) return <main className="auth-page"><p role="status">Comprobando sesión…</p></main>
  if (!session || !profile) return <Login dark={dark} toggleTheme={toggleTheme} />
  if (profile.role === 'supervisor') return <main className="auth-page"><div className="auth-card"><h1>Clasificación de acceso pendiente</h1><p>Tu perfil se conserva. Un administrador debe asignarte el rol Administrador o Cajero para continuar.</p><Button onClick={() => void signOut()}>Cerrar sesión</Button></div></main>
  const allowed = canAccessRoute(profile.role, page)
  const visiblePage = allowed ? page : homeRoute(profile.role) as PageId
  const content = {
    dashboard: <Dashboard />,
    pos: <PointOfSale />,
    inventario: <Inventory />,
    estadisticas: <Statistics />,
    contabilidad: <Accounting />,
    clientes: <Directory key="clientes" type="clientes" />,
    proveedores: <Directory key="proveedores" type="proveedores" />,
    creditos: <Credits />,
    auditoria: <Audit />,
    configuracion: profile.role === 'admin' ? <Settings dark={dark} toggleTheme={toggleTheme} /> : <p role="alert">Esta sección requiere un administrador.</p>,
  }
  return (
      <Layout key={`${session.user.id}:${profile.role}`} page={visiblePage} dark={dark} toggleTheme={toggleTheme}>
        <OperationPeriod key={`${session.user.id}:${profile.role}`}><Suspense
          fallback={
            <p role="status" className="empty-state">
              Cargando vista…
            </p>
          }
        >
          <div key={visiblePage} className="page-content">
            {!allowed && <p role="alert">No tienes permiso para acceder a esta sección.</p>}
            {content[visiblePage]}
          </div>
        </Suspense></OperationPeriod>
      </Layout>
  )
}
