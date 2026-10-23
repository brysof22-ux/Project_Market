import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Bell,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FlaskConical,
  LogOut,
  Menu,
  Moon,
  Search,
  ShoppingBag,
  Store,
  Sun,
  X,
} from 'lucide-react'
import { Button } from './ui/button'
import { usePayments } from '../features/payments/use-payments'
import { navigation, type PageId } from '../data/navigation'
import { useAuth } from '../features/auth/context'

export function Layout({
  page,
  dark,
  toggleTheme,
  children,
}: {
  page: PageId
  dark: boolean
  toggleTheme: () => void
  children: ReactNode
}) {
  const { actor } = usePayments()
  const { session, signOut } = useAuth()
  const identity = session?.user.email ?? 'Usuario autenticado'
  const roleLabel = {
    admin: 'Administrador',
    supervisor: 'Supervisor',
    cashier: 'Cajero',
  }[actor.role]
  const [mobileOpen, setMobileOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [popover, setPopover] = useState<
    'notifications' | 'profile' | 'help' | null
  >(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === 'Escape') {
        setMobileOpen(false)
        setSearch('')
        setPopover(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const current = navigation.find((item) => item.id === page)!
  return (
    <div className="app-shell">
      <a
        href="#main"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main')?.focus()
        }}
      >
        Saltar al contenido
      </a>
      {mobileOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Cerrar navegación"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        id="main-navigation"
        className={`sidebar ${mobileOpen ? 'is-open' : ''}`}
      >
        <a className="brand" href="#/dashboard">
          <span className="brand-mark">
            <ShoppingBag size={23} strokeWidth={1.8} />
          </span>
          <span>
            cai<span className="brand-light">market</span>
            <small>GESTIÓN DE TIENDA</small>
          </span>
        </a>
        <Button
          variant="ghost"
          size="icon"
          className="mobile-close"
          aria-label="Cerrar menú"
          onClick={() => setMobileOpen(false)}
        >
          <X size={20} />
        </Button>
        <div className="store-switch">
          <span className="store-icon">
            <Store size={19} />
          </span>
          <div>
            <strong>Mi tienda</strong>
            <small>Sede principal</small>
          </div>
          <span className="store-dot" title="Entorno de demostración" />
        </div>
        <p className="nav-label">PRINCIPAL</p>
        <nav aria-label="Navegación principal">
          {navigation.map((item, i) => (
            <a
              key={item.id}
              href={`#/${item.id}`}
              aria-label={item.label}
              aria-current={page === item.id ? 'page' : undefined}
              className={`nav-item ${page === item.id ? 'active' : ''} ${i === 7 ? 'nav-settings' : ''}`}
              onClick={() => setMobileOpen(false)}
            >
              <item.icon size={19} strokeWidth={1.7} />
              <span>{item.label}</span>
              {page === item.id && <span className="active-dot" />}
              {item.id === 'inventario' && <span className="nav-count">3</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon">
              <CircleHelp size={20} />
            </span>
            <h3>Todo bajo control</h3>
            <p>
              Tu negocio, más organizado.
              <br />
              Estamos para ayudarte.
            </p>
            <button onClick={() => setPopover('help')}>
              Centro de ayuda <ArrowIcon />
            </button>
          </div>
          <button className="theme-toggle" onClick={toggleTheme}>
            {dark ? <Sun size={17} /> : <Moon size={17} />}
            <span>{dark ? 'Modo claro' : 'Modo oscuro'}</span>
            <span className={`switch ${dark ? 'on' : ''}`} />
          </button>
          <div className="sidebar-footer">
            <span className="mini-brand">cai</span>
            <span>Hecho para tu negocio.</span>
            <small>v0.1</small>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-menu"
              aria-label="Abrir menú"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={20} />
            </Button>
            <span className="breadcrumb-home">Mi tienda</span>
            <ChevronRight size={14} />
            <strong>{current.label}</strong>
          </div>
          <div className="topbar-actions">
            <div className="global-search">
              <Search size={17} />
              <input
                ref={searchRef}
                aria-label="Buscar módulos"
                placeholder="Buscar en tu tienda…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>⌘ K</kbd>
              {search && (
                <div className="search-results">
                  {navigation
                    .filter((item) =>
                      item.label
                        .toLocaleLowerCase('es')
                        .includes(search.toLocaleLowerCase('es')),
                    )
                    .map((item) => (
                      <a
                        key={item.id}
                        href={`#/${item.id}`}
                        onClick={() => {
                          setSearch('')
                          setMobileOpen(false)
                        }}
                      >
                        <item.icon size={16} />
                        {item.label}
                        <ChevronRight size={14} />
                      </a>
                    ))}
                  {!navigation.some((item) =>
                    item.label
                      .toLocaleLowerCase('es')
                      .includes(search.toLocaleLowerCase('es')),
                  ) && <p>No se encontraron módulos.</p>}
                </div>
              )}
            </div>
            <span className="top-divider" />
            <Button
              variant="ghost"
              size="icon"
              className="notification-button"
              aria-label="Notificaciones"
              onClick={() =>
                setPopover(popover === 'notifications' ? null : 'notifications')
              }
            >
              <Bell size={19} />
              <span />
            </Button>
            <button
              className="profile"
              aria-label="Perfil de usuario"
              onClick={() =>
                setPopover(popover === 'profile' ? null : 'profile')
              }
            >
              <span className="avatar avatar-profile">
                {identity
                  .split(' ')
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join('')}
              </span>
              <span className="profile-label">
                <strong title={identity}>{identity}</strong>
                <small>Sesión activa</small>
              </span>
              <ChevronDown size={14} />
            </button>
          </div>
        </header>
        {popover && (
          <div className="top-popover" role="region" aria-label="Información">
            <Button
              className="popover-close"
              variant="ghost"
              size="icon"
              aria-label="Cerrar información"
              onClick={() => setPopover(null)}
            >
              <X size={16} />
            </Button>
            <h3>
              {popover === 'notifications'
                ? 'Notificaciones de muestra'
                : popover === 'profile'
                  ? 'Mi cuenta'
                  : 'Centro de ayuda'}
            </h3>
            <p>
              {popover === 'notifications'
                ? '3 productos están por debajo de su stock mínimo. Revisa el inventario para conocer el detalle.'
                : popover === 'profile'
                  ? `${identity}. Acceso con Supabase Auth. Los pagos y el rol ${roleLabel} del simulador siguen siendo de demostración.`
                  : 'Explora los módulos desde el menú. Los datos son ficticios y las acciones de demostración no afectan una tienda real.'}
            </p>
            {popover === 'profile' && <Button variant="outline" className="mt-3" onClick={() => void signOut()}><LogOut size={16} />Cerrar sesión</Button>}
          </div>
        )}
        <main id="main" tabIndex={-1}>
          <div className="demo-strip">
            <FlaskConical size={13} />
            <span>Espacio de demostración</span>
            <span className="demo-separator">·</span>
            <span>Datos simulados</span>
            <span className="demo-date">23 de octubre de 2026</span>
          </div>
          {children}
          <footer className="main-footer">
            <span>© 2026 CAI Market</span>
            <span>
              Una visión clara de tu negocio.
              <span className="footer-dot">●</span> Entorno de demostración
            </span>
          </footer>
        </main>
      </div>
    </div>
  )
}
function ArrowIcon() {
  return <ChevronRight size={14} />
}
