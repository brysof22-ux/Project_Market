import { useState } from 'react'
import { Banknote, DollarSign, Package, ShoppingBag } from 'lucide-react'
import { Metric, PageHeading } from '../components/common'
import { SalesChart, TopProductsChart } from '../components/charts'
import { Button } from '../components/ui/button'
import { useOperationsQuery } from './catalog/hooks'
import { QueryState } from './catalog/common'
import { TodaySalesHistory } from './operations/today-sales'
import { FinancialCharts, FinancialMetrics } from './operations/financial-report'
import { money } from '../lib/utils'
import type { Report } from '../../shared/operations'

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function period(range: string) {
  const to = today()
  const start = new Date(`${to}T12:00:00Z`)
  if (range === 'last30') start.setUTCDate(start.getUTCDate() - 29)
  if (range === 'week') start.setUTCDate(start.getUTCDate() - 6)
  if (range === 'month') start.setUTCDate(1)
  return { from: start.toISOString().slice(0, 10), to }
}
function exportReport(data: Report) {
  const escape = (value: string) => `"${(/^(?:\s*[=+\-@]|[\t\r])/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`
  const rows = [['Desde', data.from], ['Hasta', data.to], ['Ventas brutas', data.gross_sales], ['Devoluciones', data.returns],
    ['Ventas netas', data.net_sales], ['Recaudos netos', data.collections], ...data.top_products.map((row) => [row.name, String(row.quantity), row.total])]
  const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map((row) => row.map(escape).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `reporte-${data.from}-${data.to}.csv`; anchor.click(); URL.revokeObjectURL(url)
}
export function Statistics() {
  const [range, setRange] = useState('week')
  const [customFrom,setCustomFrom]=useState(today())
  const [customTo,setCustomTo]=useState(today())
  const dates = range==='custom'?{from:customFrom,to:customTo}:period(range)
  const query = useOperationsQuery<Report>('report', dates)
  const data = query.data
  const comparison = data && Number(data.previous_sales) !== 0
    ? `${((Number(data.net_sales) / Number(data.previous_sales) - 1) * 100).toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`
    : 'Sin base de comparación'
  return <>
    <PageHeading title="Estadísticas" subtitle="Indicadores calculados desde las operaciones registradas, en horario de Bogotá.">
      <Button variant="outline" disabled={!data} onClick={() => { if (data) exportReport(data) }}>Exportar reporte</Button>
      <Button asChild><a href="#/pos">Nueva venta</a></Button>
      <Button asChild variant="outline"><a href="#/inventario?stock=bajo">Revisar stock bajo</a></Button>
    </PageHeading>
    <div className="table-toolbar"><label className="form-label">Período de indicadores<select aria-label="Período de indicadores" value={range} onChange={(event) => setRange(event.target.value)}>
      <option value="today">Hoy</option><option value="week">Últimos 7 días</option><option value="last30">Últimos 30 días</option><option value="month">Mes actual</option><option value="custom">Rango personalizado</option>
    </select></label>{range==='custom'&&<><label className="form-label">Desde<input type="date" value={customFrom} max={customTo} onChange={event=>setCustomFrom(event.target.value)}/></label><label className="form-label">Hasta<input type="date" value={customTo} min={customFrom} onChange={event=>setCustomTo(event.target.value)}/></label></>}<Button variant="outline" onClick={query.refresh}>Actualizar indicadores</Button></div>
    <QueryState {...query} retry={query.refresh} />
    {data && <>
      {data.limited && <p className="notice">Vista limitada a tus ventas y recaudos. Los datos globales de cartera, gastos y utilidad requieren otro permiso.</p>}
      {data.financial ? <FinancialMetrics report={data}/> : <div className="metrics-grid">
        <Metric label="Ventas netas del período" value={money(Number(data.net_sales))} description="Ventas del período después de devoluciones." change={comparison} note="vs. período anterior" icon={DollarSign}
          trend={Number(data.previous_sales) === 0 ? 'neutral' : Number(data.net_sales) >= Number(data.previous_sales) ? 'up' : 'down'} />
        <Metric label="Transacciones" value={String(data.transactions)} description="Número de ventas registradas en el período." change="Ventas registradas" note={`${data.from} a ${data.to}`} icon={ShoppingBag} trend="neutral" />
        <Metric label="Recaudos netos" value={money(Number(data.collections))} description="Dinero recibido menos reintegros; no incluye créditos pendientes." change="Pagos y abonos menos reintegros" note="No son nuevas ventas" icon={Banknote} trend="neutral" />
        <Metric label="Productos en catálogo" value={String(data.products)} description="Productos activos y alertas de stock mínimo." change={`${data.low_stock} con stock bajo`} note="Existencias actuales" icon={Package} trend="neutral" />
      </div>}
      <div className="charts-grid"><SalesChart data={data.series.map((row) => ({ day: row.day, actual: Number(row.actual), previous: Number(row.previous) }))} /><TopProductsChart data={data.top_products} /></div>
      <FinancialCharts report={data}/>
      <TodaySalesHistory />
    </>}
  </>
}

