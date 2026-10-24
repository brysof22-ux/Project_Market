import { useState } from 'react'
import { EmptyState, PageHeading, Panel, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { useAuth } from '../auth/context'
import { QueryState } from '../catalog/common'
import { useOperationsQuery } from '../catalog/hooks'
import { AmountField, ContactPicker, OperationForm } from './forms'
import { money } from '../../lib/utils'
import type { Bootstrap, CreditAccount } from '../../../shared/operations'

export function Credits() {
  const bootstrap = useOperationsQuery<Bootstrap>('bootstrap', {})
  const [offset, setOffset] = useState(0)
  const [notice, setNotice] = useState('')
  const accounts = useOperationsQuery<CreditAccount[]>('credits.list', { limit: 20, offset })
  const [selected, setSelected] = useState<string | null>(null)
  const { profile } = useAuth()
  const done = () => { setNotice('Operación de cartera registrada.'); accounts.refresh(); bootstrap.refresh() }
  return <>
    <PageHeading title="Créditos y cartera" subtitle="Saldos, cupos y abonos registrados. Los abonos no se cuentan como nuevas ventas." />
    {notice && <p role="status">{notice}</p>}
    <QueryState {...bootstrap} retry={bootstrap.refresh} />
    <Panel><SectionTitle title="Cuentas por cobrar" /><QueryState {...accounts} retry={accounts.refresh} />
      <div className="table-scroll"><table><thead><tr><th>CLIENTE</th><th>CUPO</th><th>DEUDA</th><th>DISPONIBLE</th><th>VENCIDO</th><th>HISTORIAL</th></tr></thead>
        <tbody>{accounts.data?.map((account) => <tr key={account.id}><td>{account.name}</td><td>{money(account.authorized_limit)}</td><td>{money(account.outstanding)}</td><td>{money(account.available)}</td><td>{money(account.overdue)}</td><td><Button variant="ghost" onClick={() => setSelected(account.customer_id)}>Ver historial</Button></td></tr>)}</tbody></table></div>
      {accounts.data?.length === 0 && <EmptyState text="No hay cuentas de crédito registradas." />}
      <Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</Button>
      <Button variant="outline" disabled={(accounts.data?.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>Siguiente</Button>
    </Panel>
    {selected && <CreditHistory customerId={selected} />}
    {bootstrap.data?.permissions.credit && <div className="settings-grid">
      {profile?.role !== 'cashier' && <Panel><SectionTitle title="Autorizar cupo" />
        <OperationForm action="credit.limit" onDone={done} label="Registrar autorización">
          <ContactPicker required /><AmountField min="0" label="Nuevo cupo total" />
          <label className="form-label">Motivo de autorización<input name="reason" required pattern=".*\S.*" maxLength={500} /></label>
        </OperationForm>
      </Panel>}
      <Panel><SectionTitle title="Registrar abono" />
        {bootstrap.data.session ? <OperationForm action="credit.receipt" defaults={{ session_id: bootstrap.data.session.id }} onDone={done} label="Registrar abono recibido">
          <ContactPicker required /><AmountField />
          <label className="form-label">Método<select name="method_id" required>{bootstrap.data.methods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label>
          <label className="form-label">Referencia (obligatoria fuera de efectivo)<input name="reference" maxLength={160} /></label>
          <label className="checkbox-label"><input type="checkbox" required />Confirmo el valor recibido.</label>
        </OperationForm> : <p>Abre tu caja para registrar abonos. <a href="#/contabilidad">Ir a caja</a></p>}
      </Panel>
    </div>}
  </>
}
function CreditHistory({ customerId }: { customerId: string }) {
  const [offset, setOffset] = useState(0)
  const query = useOperationsQuery<{
    purchases: {charge_id:string;purchased_on:string;due_on:string;principal:string;outstanding:string;status:string;responsible:string}[]
    receipts: {source_id:string;occurred_at:string;amount:string;method:string;responsible:string}[]
    limit_authorizations: {id:number;new_limit:string;reason:string;responsible:string}[]
    returns: {id:string;created_at:string;refund_amount:string;credit_reduction:string;reason:string}[]
  }>('credit.history', { customer_id: customerId, limit: 20, offset })
  return <Panel><SectionTitle title="Historial de crédito" /><QueryState {...query} retry={query.refresh} />
    {query.data && <><h3>Compras financiadas</h3><ul>{query.data.purchases.map((row) => <li key={row.charge_id}>{row.purchased_on} · Principal: {money(Number(row.principal))} · Saldo: {money(Number(row.outstanding))} · Vence: {row.due_on} · {row.responsible}</li>)}</ul>
      <h3>Pagos y abonos</h3><ul>{query.data.receipts.map((row) => <li key={row.source_id}>{new Date(row.occurred_at).toLocaleString('es-CO')} · {money(Number(row.amount))} · {row.method} · {row.responsible}</li>)}</ul>
      <h3>Autorizaciones de cupo</h3><ul>{query.data.limit_authorizations.map((row) => <li key={row.id}>{money(Number(row.new_limit))} · {row.reason} · {row.responsible}</li>)}</ul>
      <h3>Devoluciones</h3><ul>{query.data.returns.map((row) => <li key={row.id}>{new Date(row.created_at).toLocaleString('es-CO')} · Reintegro: {money(Number(row.refund_amount))} · Deuda cancelada: {money(Number(row.credit_reduction))} · {row.reason}</li>)}</ul></>}
    <Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</Button>
    <Button variant="outline" onClick={() => setOffset(offset + 20)}>Siguiente</Button>
  </Panel>
}
