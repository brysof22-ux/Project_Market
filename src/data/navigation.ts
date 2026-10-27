import {
  BarChart3,
  Package,
  Settings2,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  CreditCard,
  ShieldCheck,
} from 'lucide-react'

export const navigation = [
  { id: 'pos', label: 'Punto de venta', icon: ShoppingCart },
  { id: 'inventario', label: 'Inventario', icon: Package },
  { id: 'estadisticas', label: 'Estadísticas', icon: BarChart3 },
  { id: 'contabilidad', label: 'Contabilidad', icon: Wallet },
  { id: 'clientes', label: 'Clientes', icon: Users },
  { id: 'proveedores', label: 'Proveedores', icon: Truck },
  { id: 'creditos', label: 'Deudas', icon: CreditCard },
  { id: 'auditoria', label: 'Auditoría', icon: ShieldCheck },
  { id: 'configuracion', label: 'Configuración', icon: Settings2 },
] as const
export type PageId = (typeof navigation)[number]['id']
