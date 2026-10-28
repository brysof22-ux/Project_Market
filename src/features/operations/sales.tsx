import { useState } from 'react'
import { Badge, EmptyState, Panel, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { useAuth } from '../auth/context'
import { useOperationsQuery } from '../catalog/hooks'
import { QueryState, Pagination } from '../catalog/common'
import { OperationForm } from './forms'
import {businessTime} from '../../lib/business-format'
import { money } from '../../lib/utils'
import type { Bootstrap, SalesPage } from '../../../shared/operations'

export function SalesHistory({ revision = 0, customerId, title = 'Historial de ventas', onChanged }: { revision?: number; customerId?: string; title?: string; onChanged?: () => void }) {
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const query = useOperationsQuery<SalesPage>('sales.list', { offset, limit: 20, revision, ...(customerId ? { customer_id: customerId } : {}) })
  return <Panel><SectionTitle title={title} /><QueryState {...query} retry={query.refresh} />
    {query.data && <><div className="table-scroll" tabIndex={0} role="region" aria-label={title}><table><thead><tr><th>VENTA</th><th>FECHA</th><th>CLIENTE</th><th className="numeric-cell">TOTAL</th><th>ESTADO</th><th>DETALLE</th></tr></thead>
      <tbody>{query.data.rows.map((row) => <tr key={row.id}><td><strong>V-{row.number}</strong></td><td>{new Date(row.created_at).toLocaleString('es-CO')}</td><td>{row.customer ?? 'Consumidor final'}</td><td className="numeric-cell">{money(Number(row.total))}</td><td><Badge tone={row.returned ? 'neutral' : 'green'}>{row.returned ? 'Devuelta' : 'Registrada'}</Badge></td>
        <td><Button variant="ghost" size="sm" aria-label={`Ver venta V-${row.number}`} onClick={() => setSelected(row.id)}>Ver detalle</Button></td></tr>)}</tbody></table>{!query.data.rows.length && <EmptyState text="No hay ventas registradas." />}</div>
      <Pagination offset={offset} total={query.data.total} onChange={setOffset} /></>}
    {selected && <Dialog open onOpenChange={(open) => { if (!open) setSelected(null) }} title="Detalle de venta" description="Registro original y operaciones de devolución asociadas.">
      <SaleDetail id={selected} returned={() => { setSelected(null); query.refresh(); onChanged?.() }} />
    </Dialog>}
  </Panel>
}
type Detail = { id: string; number:number;created_at:string;customer?:string; total: number; items: { id: string; name_snapshot: string; quantity: number; unit_price: number }[]; payments: { id: string; amount: number; method?:string; reference: string | null }[]; credit: { outstanding: number; due_on: string | null } | null; return: { reason: string; refund_amount: number; credit_reduction: number } | null }
export function SaleDetail({ id, returned }: { id: string; returned: () => void }) {
  const query = useOperationsQuery<Detail>('sales.detail', { id })
  const bootstrap = useOperationsQuery<Bootstrap>('bootstrap', {})
  const { profile } = useAuth()
  const detail = query.data
  return <><QueryState {...query} retry={query.refresh} />
    {detail && <><h3>Venta V-{detail.number}</h3><p>{businessTime(detail.created_at)} · {detail.customer??'Consumidor final'}</p><p>Estado: <Badge tone={detail.return?'neutral':detail.credit&&detail.credit.outstanding>0?'amber':'green'}>{detail.return?'Devuelta':detail.credit&&detail.credit.outstanding>0?'Pendiente':'Completada'}</Badge></p><p>Total original: <strong>{money(detail.total)}</strong></p><ul className="detail-lines">{detail.items.map((item) => <li key={item.id}>{item.quantity} × {item.name_snapshot} · {money(item.unit_price)}</li>)}</ul>
      <ul className="detail-lines">{detail.payments.map(payment=><li key={payment.id}>{payment.method??'Pago'} · {money(payment.amount)}</li>)}</ul><p>Pagos registrados: {money(detail.payments.reduce((sum, payment) => sum + payment.amount, 0))}</p>
      {detail.credit && <p>Saldo de crédito: {money(detail.credit.outstanding)} · {detail.credit.due_on ? `Vence: ${detail.credit.due_on}` : 'Sin vencimiento'}</p>}
      {detail.return ? <p>Devolución: {detail.return.reason} · Reintegro: {money(detail.return.refund_amount)} · Deuda cancelada: {money(detail.return.credit_reduction)}</p>
        : profile?.role === 'admin' && bootstrap.data?.session && <OperationForm action="sale.return" defaults={{ sale_id: id, session_id: bootstrap.data.session.id }} onDone={returned} label="Confirmar devolución completa">
          <p className="notice">Devuelve toda la venta, repone las existencias y registra el reintegro manual de lo pagado. La deuda pendiente se cancela sin inventar efectivo.</p>
          <label className="form-label">Método de reintegro<select name="method_id" required>{bootstrap.data.methods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label>
          <label className="form-label">Referencia del reintegro<input name="reference" maxLength={160} /></label>
          <label className="form-label">Motivo<input name="reason" required pattern=".*\S.*" maxLength={500} /></label>
          <label className="checkbox-label"><input type="checkbox" required />Confirmo la devolución de los productos y el reintegro indicado.</label>
        </OperationForm>}
    </>}
  </>
}
