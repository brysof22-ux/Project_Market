import type { StaffRole } from './profile'
import { catalogActions } from './catalog'
import { operationActions } from './operations'

// This is a UI/HTTP boundary. PostgreSQL independently authorizes every RPC.
const adminRoutes = ['dashboard', 'pos', 'inventario', 'estadisticas', 'contabilidad', 'clientes', 'proveedores', 'creditos', 'auditoria', 'configuracion']
const cashierRoutes = ['pos', 'creditos']
const cashierCatalog = ['qr.list', 'qr.read', 'products.list', 'customers.search', 'media.read']
const cashierOperations = ['bootstrap', 'cash.open', 'cash.close', 'cash.list', 'cash.entries',
  'sale.confirm', 'sales.list', 'sales.detail',
  'debts.list', 'debt.detail', 'debt.receipt']

export function canAccessRoute(role: StaffRole | null | undefined, route: string): boolean {
  return role === 'admin' ? adminRoutes.includes(route) : role === 'cashier' && cashierRoutes.includes(route)
}
export const canAccessPage = canAccessRoute

export function homeRoute(role: StaffRole | null | undefined): string {
  return role === 'admin' ? 'dashboard' : role === 'cashier' ? 'pos' : ''
}

export function canPerform(role: StaffRole | null | undefined, section: 'catalog' | 'operations', action: string): boolean {
  const knownActions: readonly string[] = section === 'catalog' ? catalogActions : operationActions
  if (!knownActions.includes(action)) return false
  if (role === 'admin') return true
  if (role !== 'cashier') return false // Preserve Supervisor profiles without inheriting privileges.
  return (section === 'catalog' ? cashierCatalog : cashierOperations).includes(action)
}
