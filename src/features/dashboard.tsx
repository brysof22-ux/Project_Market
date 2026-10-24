import { useState } from 'react'
import { Banknote, DollarSign, Package, ShoppingBag } from 'lucide-react'
import { Metric, PageHeading, Panel, SectionTitle } from '../components/common'
import { SalesChart, CategoryChart } from '../components/charts'
import { Button } from '../components/ui/button'
import { useOperationsQuery } from './catalog/hooks'
import { QueryState } from './catalog/common'
import { SalesHistory } from './operations/sales'
import { money } from '../lib/utils'
import type { Report } from '../../shared/operations'

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function period(range: string) {
  const to = today()
  const start = new Date(`${to}T12:00:00Z`)
  if (range === 'week') start.setUTCDate(start.getUTCDate() - 6)
  if (range === 'month') start.setUTCDate(1)
  return { from: start.toISOString().slice(0, 10), to }
}
function exportReport(data: Report) {
  const escape = (value: string) => `"${(/^(?:\s*[=+\-@]|[\t\r])/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`
  const rows = [['Desde', data.from], ['Hasta', data.to], ['Ventas brutas', data.gross_sales], ['Devoluciones', data.returns],
    ['Ventas netas', data.net_sales], ['Recaudos netos', data.collections], ...data.categories.map((row) => [row.category, row.total])]
  const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map((row) => row.map(escape).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `reporte-${data.from}-${data.to}.csv`; anchor.click(); URL.revokeObjectURL(url)
}
export function ReportView({ statistics = false }: { statistics?: boolean }) {
  const [range, setRange] = useState('week')
  const dates = period(range)
  const query = useOperationsQuery<Report>('report', dates)
  const data = query.data
  const comparison = data && Number(data.previous_sales) !== 0
    ? `${((Number(data.net_sales) / Number(data.previous_sales) - 1) * 100).toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`
    : 'Sin base de comparación'
  return <>
    <PageHeading title={statistics ? 'Estadísticas' : 'Tu negocio, de un vistazo'} subtitle="Indicadores calculados desde las operaciones registradas, en horario de Bogotá.">
      <Button variant="outline" disabled={!data} onClick={() => { if (data) exportReport(data) }}>Exportar reporte</Button>
      <Button asChild><a href="#/pos">Nueva venta</a></Button>
      <Button asChild variant="outline"><a href="#/inventario?stock=bajo">Revisar stock bajo</a></Button>
    </PageHeading>
    <div className="table-toolbar"><label className="form-label">Período de indicadores<select aria-label="Período de indicadores" value={range} onChange={(event) => setRange(event.target.value)}>
      <option value="today">Hoy</option><option value="week">Últimos 7 días</option><option value="month">Este mes</option>
    </select></label><Button variant="outline" onClick={query.refresh}>Actualizar indicadores</Button></div>
    <QueryState {...query} retry={query.refresh} />
    {data && <>
      {data.limited && <p className="notice">Vista limitada a tus ventas y recaudos. Los datos globales de cartera, gastos y utilidad requieren otro permiso.</p>}
      <div className="metrics-grid">
        <Metric label="Ventas netas del período" value={money(Number(data.net_sales))} change={comparison} note="vs. período anterior" icon={DollarSign}
          trend={Number(data.previous_sales) === 0 ? 'neutral' : Number(data.net_sales) >= Number(data.previous_sales) ? 'up' : 'down'} />
        <Metric label="Transacciones" value={String(data.transactions)} change="Ventas registradas" note={`${data.from} a ${data.to}`} icon={ShoppingBag} trend="neutral" />
        <Metric label="Recaudos netos" value={money(Number(data.collections))} change="Pagos y abonos menos reintegros" note="No son nuevas ventas" icon={Banknote} trend="neutral" />
        <Metric label="Productos en catálogo" value={String(data.products)} change={`${data.low_stock} con stock bajo`} note="Existencias actuales" icon={Package} trend="neutral" />
      </div>
      <div className="charts-grid"><SalesChart data={data.series.map((row) => ({ day: row.day, actual: Number(row.actual), previous: Number(row.previous) }))} /><CategoryChart data={data.categories} /></div>
      <div className="settings-grid"><Panel><SectionTitle title="Control financiero" />
        <dl className="detail-list"><div><dt>Ventas brutas</dt><dd>{money(Number(data.gross_sales))}</dd></div><div><dt>Devoluciones</dt><dd>{money(Number(data.returns))}</dd></div>
          <div><dt>Gastos operativos</dt><dd>{data.expenses === null ? 'Acceso restringido' : money(Number(data.expenses))}</dd></div>
          <div><dt>Otros ingresos de caja</dt><dd>{data.cash_income === null ? 'Acceso restringido' : money(Number(data.cash_income))}</dd></div>
          <div><dt>Cartera pendiente actual</dt><dd>{data.outstanding === null ? 'Acceso restringido' : money(Number(data.outstanding))}</dd></div>
          <div><dt>Utilidad bruta estimada</dt><dd>{data.gross_profit === null ? 'No disponible con los datos o permisos actuales' : money(Number(data.gross_profit))}</dd></div></dl>
        {data.unknown_cost_items > 0 && <p>Faltan costos históricos en {data.unknown_cost_items} líneas; no se estima su utilidad.</p>}
      </Panel><Panel><SectionTitle title="Productos más vendidos" /><ul>{data.top_products.map((row) => <li key={row.product_id}>{row.name} · {row.quantity} uds. netas · {money(Number(row.total))}</li>)}</ul>
        {!data.top_products.length && <p className="empty-state">Sin productos vendidos en este período.</p>}
        <SectionTitle title="Recaudos por método" /><ul>{data.methods.map((row) => <li key={row.code}>{row.name} · {money(Number(row.total))}</li>)}</ul>
        {!data.limited && <><SectionTitle title="Utilidad bruta por categoría" /><ul>{data.categories.map((row) => <li key={row.category}>{row.category} · {row.gross_profit === null ? 'Sin costo histórico suficiente' : money(Number(row.gross_profit))}</li>)}</ul></>}
      </Panel></div>
      {!statistics && <SalesHistory />}
    </>}
  </>
}
export function Dashboard() { return <ReportView /> }
export function Statistics() { return <ReportView statistics /> }
