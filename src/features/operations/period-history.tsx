import { useState } from 'react'
import { Panel, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { QueryState } from '../catalog/common'
import { useOperationsQuery } from '../catalog/hooks'
import { money } from '../../lib/utils'
import type { ArchivedPeriod, OperatingPeriod } from '../../../shared/operations'

export function PeriodHistory() {
  const query = useOperationsQuery<OperatingPeriod[]>('periods.list', {})
  const [selected, setSelected] = useState<string | null>(null)
  return <Panel><SectionTitle title="Períodos operativos" subtitle="El historial archivado se conserva en modo de consulta." /><QueryState {...query} retry={query.refresh} />
    <ul>{query.data?.map((period) => <li key={period.id}>{new Date(period.opened_at).toLocaleString('es-CO')} · {period.closed_at ? 'Archivado' : 'Activo'} · {period.reason}
      {period.closed_at && <Button variant="ghost" onClick={() => setSelected(period.id)}>Consultar período {period.id}</Button>}
    </li>)}</ul>
    {selected && <ArchivedDetail key={selected} id={selected} />}
  </Panel>
}
function ArchivedDetail({ id }: { id: string }) {
  const [offset, setOffset] = useState(0)
  const query = useOperationsQuery<ArchivedPeriod>('periods.detail', { period_id: id, limit: 20, offset })
  return <><h3>Archivo del período {id}</h3><p>Solo consulta. Los registros archivados no admiten ventas, abonos ni devoluciones. Cada página muestra hasta 20 registros por sección.</p><QueryState {...query} retry={query.refresh} />
    {query.data && <>
      <h4>Ventas</h4><ul>{query.data.sales.map((sale) => <li key={sale.id}>V-{sale.number} · {sale.buyer_name || 'Consumidor final'} · {money(Number(sale.total))}</li>)}</ul>
      <h4>Deudas conservadas</h4><ul>{query.data.debts.map((debt) => <li key={debt.id}>{debt.name} · {debt.phone} · Saldo: {money(Number(debt.outstanding))} · Abonos recibidos: {money(Number(debt.paid))}{debt.returned ? ` · Devuelta · Reintegro: ${money(Number(debt.refund_amount))} · Deuda cancelada: ${money(Number(debt.return_credit_reduction))}` : ''}</li>)}</ul>
      <h4>Existencias al archivar</h4><ul>{query.data.stock.map((row) => <li key={row.product_id}>{row.product_id} · {row.quantity} unidades</li>)}</ul>
      <p>Ventas: {query.data.totals.sales} · Deudas: {query.data.totals.debts} · Productos: {query.data.totals.stock} · Página {offset / 20 + 1}</p>
      <Button variant="outline" disabled={!offset} onClick={() => setOffset((value) => Math.max(0, value - 20))}>Anterior en archivo</Button>
      <Button variant="outline" disabled={offset + 20 >= Math.max(...Object.values(query.data.totals))} onClick={() => setOffset((value) => value + 20)}>Siguiente en archivo</Button>
    </>}
  </>
}
