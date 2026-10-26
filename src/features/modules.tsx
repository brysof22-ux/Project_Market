import { useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Search,
  Users,
  Wallet,
} from 'lucide-react'
import {
  Badge,
  EmptyState,
  Metric,
  Panel,
  SectionTitle,
} from '../components/common'
import { TopProductsChart, SalesChart } from '../components/charts'
import { Button } from '../components/ui/button'
import { customers, suppliers } from '../data/mock'
import { PageHeading } from '../components/common'
import { SalesTable } from '../components/sales-table'
import { DemoPermissions, MethodSettings } from './payments/method-settings'
import { PaymentHistory } from './payments/history'

export function Statistics() {
  return (
    <>
      <PageHeading
        title="Estadísticas"
        subtitle="Explora las tendencias comerciales de un negocio de ejemplo."
      />
      <div className="metrics-grid three">
        <Metric
          label="Ventas de la semana"
          value="$ 17.075.000"
          change="30,4 %"
          icon={Banknote}
          note="Comparación simulada"
        />
        <Metric
          label="Transacciones semanales"
          value="486"
          change="16,2 %"
          icon={ArrowUpRight}
          note="Comparación simulada"
        />
        <Metric
          label="Clientes de la semana"
          value="312"
          change="10,4 %"
          icon={Users}
          note="Comparación simulada"
        />
      </div>
      <div className="charts-grid">
        <SalesChart />
        <TopProductsChart />
      </div>
      <Panel className="insight-panel">
        <span className="metric-icon">
          <ArrowUpRight size={20} />
        </span>
        <div>
          <h2>El sábado lidera las ventas</h2>
          <p className="muted">
            En la serie de ejemplo, el sábado registra $ 3.420.000. Alimentos
            representa el 42 % de las ventas de productos.
          </p>
        </div>
        <Badge tone="neutral">Análisis de muestra</Badge>
      </Panel>
    </>
  )
}
export function Accounting() {
  return (
    <>
      <PageHeading
        title="Contabilidad"
        subtitle="Resumen financiero ilustrativo. No sustituye un registro contable."
      />
      <div className="metrics-grid three">
        <Metric
          label="Ingresos de hoy"
          value="$ 2.845.000"
          change="12,6 %"
          icon={ArrowUpRight}
          note="Dato simulado"
        />
        <Metric
          label="Gastos de hoy"
          value="$ 1.240.000"
          change="5,2 %"
          icon={ArrowDownLeft}
          trend="down"
          note="Dato simulado"
        />
        <Metric
          label="Balance de hoy"
          value="$ 1.605.000"
          change="Saldo positivo"
          icon={Wallet}
          note="Sin conciliación real"
        />
      </div>
      <SalesTable full />
      <PaymentHistory />
      <div className="notice mt-5">
        Vista inicial: el registro de gastos, los cierres de caja, los impuestos
        y los reportes contables están pendientes de implementación.
      </div>
    </>
  )
}
export function Directory({ type }: { type: 'clientes' | 'proveedores' }) {
  const [search, setSearch] = useState('')
  const isCustomers = type === 'clientes'
  const rows = isCustomers ? customers : suppliers
  const filtered = rows.filter((row) =>
    row
      .join(' ')
      .toLocaleLowerCase('es')
      .includes(search.toLocaleLowerCase('es')),
  )
  const headings = isCustomers
    ? ['CLIENTE', 'CORREO', 'COMPRAS', 'TOTAL HISTÓRICO', 'SEGMENTO']
    : ['PROVEEDOR', 'CATEGORÍA', 'CONTACTO', 'CORREO', 'ESTADO']
  return (
    <>
      <PageHeading
        title={isCustomers ? 'Clientes' : 'Proveedores'}
        subtitle={
          isCustomers
            ? 'Conoce a quienes hacen parte de tu negocio.'
            : 'Tu red de aliados, en un solo lugar.'
        }
      />
      <Panel>
        <SectionTitle
          title={
            isCustomers ? 'Directorio de clientes' : 'Directorio de proveedores'
          }
          subtitle={`${rows.length} registros ficticios · Solo consulta en esta versión`}
          action={<Badge tone="neutral">Datos simulados</Badge>}
        />
        <div className="table-toolbar">
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label={`Buscar ${type}`}
              placeholder={`Buscar ${type}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {headings.map((heading) => (
                  <th key={heading}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, index) => (
                <tr key={row[0]}>
                  {row.map((cell, i) => (
                    <td key={i}>
                      {i === 0 ? (
                        <div className="person-cell">
                          <span
                            className={`avatar ${index % 2 ? 'sand' : 'lavender'}`}
                          >
                            {cell
                              .split(' ')
                              .slice(0, 2)
                              .map((part) => part[0])
                              .join('')}
                          </span>
                          <strong>{cell}</strong>
                        </div>
                      ) : i === 4 ? (
                        <Badge tone={cell === 'Nuevo' ? 'neutral' : 'green'}>
                          {cell}
                        </Badge>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <EmptyState />}
        </div>
        <div className="table-footer">
          Mostrando {filtered.length} registros de ejemplo · Altas y edición
          pendientes
        </div>
      </Panel>
    </>
  )
}
export function Settings({
  dark,
  toggleTheme,
}: {
  dark: boolean
  toggleTheme: () => void
}) {
  const [name, setName] = useState('Mi tienda')
  const [address, setAddress] = useState('Bogotá, Colombia')
  const [saved, setSaved] = useState(false)
  return (
    <>
      <PageHeading
        title="Configuración"
        subtitle="Vista previa de las preferencias de tu tienda."
      />
      <div className="settings-grid">
        <Panel>
          <SectionTitle
            title="Información del negocio"
            subtitle="Formulario de demostración · Sin almacenamiento"
          />
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setSaved(true)
            }}
            className="settings-form"
          >
            <label className="form-label">
              Nombre de la tienda
              <input
                required
                maxLength={80}
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setSaved(false)
                }}
                pattern=".*\S.*"
                placeholder="Nombre de tu tienda"
              />
            </label>
            <label className="form-label">
              Ubicación
              <input
                required
                maxLength={160}
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value)
                  setSaved(false)
                }}
                pattern=".*\S.*"
              />
            </label>
            <label className="form-label">
              Moneda
              <select disabled defaultValue="COP">
                <option value="COP">COP — Peso colombiano</option>
              </select>
            </label>
            <p className="muted">
              Esta vista no actualiza la información global de la tienda. Los
              cambios se descartan al salir del módulo.
            </p>
            <Button type="submit">Validar datos de prueba</Button>
            {saved && (
              <p role="status" className="success-message">
                Datos válidos. Validación local completada; no se guardó
                información.
              </p>
            )}
          </form>
        </Panel>
        <div className="settings-side">
          <Panel>
            <SectionTitle
              title="Apariencia"
              subtitle="Elige cómo quieres ver tu espacio de trabajo"
            />
            <div className="appearance-preview">
              <div className={`theme-swatch ${dark ? 'dark-swatch' : ''}`}>
                <span />
                <div>
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div>
                <strong>{dark ? 'Modo oscuro' : 'Modo claro'}</strong>
                <p className="muted">Preferencia guardada en este navegador.</p>
              </div>
            </div>
            <Button variant="outline" className="w-full" onClick={toggleTheme}>
              Cambiar a modo {dark ? 'claro' : 'oscuro'}
            </Button>
          </Panel>
          <DemoPermissions />
        </div>
      </div>
      <MethodSettings />
    </>
  )
}
