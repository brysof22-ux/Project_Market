import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Bell,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShoppingBag,
  Store,
  Sun,
  X,
} from 'lucide-react'
import { Button } from './ui/button'
import { navigation, type PageId } from '../data/navigation'
import { useAuth } from '../features/auth/context'
import { canAccessRoute, homeRoute } from '../../shared/permissions'

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
  const { session, profile, signOut } = useAuth()
  const identity = session?.user.email ?? 'Usuario autenticado'
  const roleLabel = {
    admin: 'Administrador',
    supervisor: 'Supervisor',
    cashier: 'Cajero',
  }[profile?.role ?? 'cashier']
  const [mobileOpen, setMobileOpen] = useState(false)
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem('cai-market:navigation:v1') === 'compact' } catch { return false }
  })
  const [smallScreen, setSmallScreen] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const menuRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const [search, setSearch] = useState('')
  const [popover, setPopover] = useState<
    'notifications' | 'profile' | 'help' | null
  >(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const resize = () => { setSmallScreen(media.matches); if (!media.matches) setMobileOpen(false) }
    media.addEventListener('change', resize)
    return () => media.removeEventListener('change', resize)
  }, [])
  useEffect(() => {
    if (!mobileOpen || !smallScreen) return
    const menuTrigger = menuRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sidebarRef.current?.querySelector<HTMLElement>('a,button')?.focus()
    function trap(event: KeyboardEvent) {
      if (event.key !== 'Tab') return
      const items = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') ?? []).filter(item => item.getClientRects().length)
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', trap)
      menuTrigger?.focus()
    }
  }, [mobileOpen, smallScreen])
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
  const allowedNavigation = navigation.filter((item) => canAccessRoute(profile?.role, item.id))
  return (
    <div className={`app-shell ${compact ? 'sidebar-collapsed' : ''}`}>
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
        ref={sidebarRef}
        id="main-navigation"
        className={`sidebar ${mobileOpen ? 'is-open' : ''}`}
        inert={smallScreen && !mobileOpen}
        role={smallScreen && mobileOpen ? 'dialog' : undefined}
        aria-modal={smallScreen && mobileOpen ? true : undefined}
        aria-label="Menú de la tienda"
      >
        <a className="brand" href={`#/${homeRoute(profile?.role)}`}>
          <span className="brand-mark">
            <ShoppingBag size={23} strokeWidth={1.8} />
          </span>
          <span className="brand-wordmark">
            cai<span className="brand-light">market</span>
            <small>GESTIÓN DE TIENDA</small>
          </span>
        </a>
        <Button className="sidebar-collapse" variant="ghost" size="icon" aria-label={compact ? 'Expandir menú' : 'Contraer menú'} aria-expanded={!compact} aria-controls="main-navigation" onClick={() => {
          setCompact(!compact)
          try { localStorage.setItem('cai-market:navigation:v1', compact ? 'full' : 'compact') } catch { /* Navigation also works without storage. */ }
        }}>{compact ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</Button>
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
          <span className="store-dot" title="Sesión autenticada" />
        </div>
        <p className="nav-label">PRINCIPAL</p>
        <nav aria-label="Navegación principal">
          {allowedNavigation.map((item) => (
            <div key={item.id}>
            {item.id === 'configuracion' && <p className="nav-label">ADMINISTRACIÓN</p>}
            <a
              key={item.id}
              href={`#/${item.id}`}
              aria-label={item.label}
              title={compact && !smallScreen ? item.label : undefined}
              data-label={item.label}
              aria-current={page === item.id ? 'page' : undefined}
              className={`nav-item ${page === item.id ? 'active' : ''} ${item.id === 'configuracion' ? 'nav-settings' : ''}`}
              onClick={() => setMobileOpen(false)}
            >
              <item.icon size={19} strokeWidth={1.7} />
              <span>{item.label}</span>
              {page === item.id && <span className="active-dot" />}
            </a>
            </div>
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
            <button onClick={() => { setMobileOpen(false); setPopover('help') }}>
              Centro de ayuda <ArrowIcon />
            </button>
          </div>
          <button className="theme-toggle" onClick={toggleTheme} aria-label={dark ? 'Modo claro' : 'Modo oscuro'} title={compact ? (dark ? 'Modo claro' : 'Modo oscuro') : undefined}>
            {dark ? <Sun size={17} /> : <Moon size={17} />}
            <span>{dark ? 'Modo claro' : 'Modo oscuro'}</span>
            <span className={`switch ${dark ? 'on' : ''}`} />
          </button>
          <div className="sidebar-footer">
            <span className="mini-brand">cai</span>
            <span>Hecho para tu negocio.</span>
            <small>v1.4</small>
          </div>
        </div>
      </aside>
      <div className="workspace" inert={smallScreen && mobileOpen}>
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-menu"
              ref={menuRef}
              aria-label="Abrir menú"
              aria-expanded={mobileOpen}
              aria-controls="main-navigation"
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
                  {allowedNavigation
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
                  {!allowedNavigation.some((item) =>
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
                <small>{roleLabel}</small>
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
                ? 'Notificaciones'
                : popover === 'profile'
                  ? 'Mi cuenta'
                  : 'Centro de ayuda'}
            </h3>
            <p>
              {popover === 'notifications'
                ? profile?.role === 'cashier' ? 'Consulta las existencias desde Punto de venta y los saldos desde Deudas.' : 'Revisa el inventario con el filtro de stock bajo para consultar las alertas actuales.'
                : popover === 'profile'
                  ? `${identity}. Acceso con Supabase Auth. Rol: ${roleLabel}.`
                  : 'Gestiona productos, ventas, cartera y caja desde el menú. Las operaciones confirmadas se registran en la tienda.'}
            </p>
            {popover === 'profile' && <Button variant="outline" className="mt-3" onClick={() => void signOut()}><LogOut size={16} />Cerrar sesión</Button>}
          </div>
        )}
        <main id="main" tabIndex={-1}>
          {children}
          <footer className="main-footer">
            <span>© 2026 CAI Market</span>
            <span>
              Una visión clara de tu negocio.
              <span className="footer-dot">●</span> Gestión comercial
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
