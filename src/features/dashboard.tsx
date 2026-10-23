import { useState } from 'react'
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  CreditCard,
  DollarSign,
  Download,
  Package,
  Plus,
  ShoppingBag,
  TriangleAlert,
} from 'lucide-react'
import {
  Badge,
  Metric,
  PageHeading,
  Panel,
  SectionTitle,
} from '../components/common'
import { SalesChart, CategoryChart } from '../components/charts'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { SalesTable } from '../components/sales-table'
import { products, sales } from '../data/mock'
import { money } from '../lib/utils'

export function Dashboard() {
  const [reportOpen, setReportOpen] = useState(false)
  const [range, setRange] = useState('today')
  const isToday = range === 'today'
  const lowProducts = products.filter(
    (product) => product.stock < product.minimum,
  )
  function exportReport() {
    const csv =
      '\ufeffVenta;Cliente;Hora;Total COP;Estado\n' +
      sales
        .map((sale) =>
          [sale.id, sale.name, sale.time, sale.total, sale.status].join(';'),
        )
        .join('\n')
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'ventas-simuladas-2026-10-23.csv'
    anchor.click()
    URL.revokeObjectURL(url)
    setReportOpen(false)
  }
  return (
    <>
      <PageHeading
        title="Tu negocio, de un vistazo"
        subtitle="Hola, Daniel. Esto es lo que pasa hoy en tu tienda."
      >
        <Button variant="outline" onClick={() => setReportOpen(true)}>
          <Download size={16} />
          Exportar reporte
        </Button>
        <Button asChild>
          <a href="#/pos">
            <Plus size={17} />
            Nueva venta
          </a>
        </Button>
      </PageHeading>
      <div className="overview-bar">
        <div className="overview-tabs">
          <span className="selected">Resumen general</span>
          <span className="overview-note">
            <span className="live-dot" /> Tu tienda en cifras
          </span>
        </div>
        <label className="date-select">
          <CalendarDays size={15} />
          <select
            aria-label="Período de indicadores"
            value={range}
            onChange={(e) => setRange(e.target.value)}
          >
            <option value="today">Hoy, 23 oct 2026</option>
            <option value="yesterday">Ayer, 22 oct 2026</option>
          </select>
          <ChevronDown size={13} />
        </label>
      </div>
      <div className="metrics-grid">
        <Metric
          label="Ventas del día"
          value={money(isToday ? 2845000 : 2526600)}
          change="12,6 %"
          icon={DollarSign}
          note={isToday ? 'vs. ayer' : 'vs. día anterior'}
        />
        <Metric
          label="Transacciones"
          value={isToday ? '68' : '63'}
          change="7,9 %"
          icon={ShoppingBag}
          note={isToday ? 'vs. ayer' : 'vs. día anterior'}
        />
        <Metric
          label="Ticket promedio"
          value={money(isToday ? 41838 : 40105)}
          change="4,3 %"
          icon={CreditCard}
          note={isToday ? 'vs. ayer' : 'vs. día anterior'}
        />
        <Metric
          label="Productos en catálogo"
          value="8"
          change="3 con stock bajo"
          trend="neutral"
          icon={Package}
          note="Revisa tu inventario"
        />
      </div>
      <div className="charts-grid">
        <SalesChart />
        <CategoryChart />
      </div>
      <div className="dashboard-bottom">
        <SalesTable />
        <Panel className="inventory-alerts">
          <SectionTitle
            title="Atención al inventario"
            action={
              <span className="alert-icon">
                <TriangleAlert size={17} />
              </span>
            }
          />
          <p className="muted alert-description">
            <strong>{lowProducts.length} productos</strong> necesitan
            reposición.
          </p>
          <div className="low-stock-list">
            {lowProducts.map((product) => (
              <div className="low-stock-item" key={product.id}>
                <span className={`product-image ${product.color}`}>
                  {product.emoji}
                </span>
                <div>
                  <strong>{product.name}</strong>
                  <small>Mínimo: {product.minimum} unidades</small>
                </div>
                <Badge tone="amber">{product.stock} uds.</Badge>
              </div>
            ))}
          </div>
          <Button asChild variant="outline" className="w-full">
            <a href="#/inventario?stock=bajo">
              Revisar inventario <ArrowRight size={15} />
            </a>
          </Button>
          <div className="inventory-health">
            <span>
              <span className="live-dot" /> Estado del catálogo de muestra
            </span>
            <strong>5 de 8 productos con stock suficiente</strong>
            <div className="progress-track">
              <span style={{ width: '62.5%' }} />
            </div>
          </div>
        </Panel>
      </div>
      <Dialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        title="Exportar ventas de ejemplo"
        description="Descarga un CSV con las cinco transacciones ficticias del 23 de octubre de 2026. No incluye datos de una tienda real."
      >
        <Button onClick={exportReport}>
          <Download size={16} />
          Descargar CSV simulado
        </Button>
      </Dialog>
    </>
  )
}
