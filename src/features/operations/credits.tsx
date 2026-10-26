import { useCallback, useState } from 'react'
import { EmptyState, PageHeading, Panel, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { QueryState, Pagination } from '../catalog/common'
import { useOperationsMutation, useOperationsQuery, useSearch } from '../catalog/hooks'
import { TransferPicker } from '../payments/transfer-qr'
import { money } from '../../lib/utils'
import type { Bootstrap, DebtDetail, DebtPage } from '../../../shared/operations'

export function Credits() {
  const [status, setStatus] = useState('pending')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const query = useOperationsQuery<DebtPage>('debts.list', { status, search: useSearch(search), limit: 20, offset, revision })
  return <>
    <PageHeading title="Deudas" subtitle="Compras a crédito, abonos y saldos del período activo. Cada persona conserva su identidad interna." />
    <Panel><SectionTitle title="Personas y compras a crédito" />
      <div className="table-toolbar">
        <label className="form-label">Buscar persona<input value={search} maxLength={100} onChange={(event) => { setSearch(event.target.value); setOffset(0) }} placeholder="Nombre o teléfono" /></label>
        <label className="form-label">Estado de deuda<select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0) }}>
          <option value="pending">Pendientes</option><option value="overdue">Vencidas</option><option value="paid">Pagadas / liquidadas</option><option value="all">Todas</option>
        </select></label>
      </div><QueryState {...query} retry={query.refresh} />
      <div className="table-scroll"><table><thead><tr><th>PERSONA</th><th>COMPRA</th><th>PRODUCTOS</th><th>TOTAL</th><th>ABONOS</th><th>SALDO</th><th>ESTADO</th><th>DETALLE</th></tr></thead>
        <tbody>{query.data?.rows.map((debt) => <tr key={debt.charge_id}>
          <td><strong>{debt.name}</strong><small className="contact-phone">{debt.phone}</small><small className="contact-phone">ID persona: {debt.customer_id}</small></td>
          <td>{debt.purchased_on}<small className="contact-phone">{debt.due_on ? `Vence: ${debt.due_on}` : 'Sin vencimiento'}</small></td>
          <td>{debt.products.map((item, index) => <div key={index}>{item.quantity} × {item.name}</div>)}</td>
          <td>{money(Number(debt.total))}</td><td>{money(Number(debt.paid))}</td><td>{money(Number(debt.outstanding))}</td>
          <td>{debt.returned ? 'Devuelta' : ({ pending: 'Pendiente', overdue: 'Vencida', paid: 'Pagada' })[debt.status]}</td>
          <td><Button variant="ghost" onClick={() => setSelected(debt.charge_id)}>Ver deuda de {debt.name}</Button></td>
        </tr>)}</tbody></table></div>
      {query.data && !query.data.rows.length && <EmptyState text="No hay deudas con estos filtros." />}
      {query.data && <Pagination offset={offset} total={query.data.total} onChange={setOffset} />}
    </Panel>
    {selected && <DebtHistory key={selected} chargeId={selected} onChanged={() => { setRevision((value) => value + 1) }} />}
  </>
}

function DebtHistory({ chargeId, onChanged }: { chargeId: string; onChanged: () => void }) {
  const detail = useOperationsQuery<DebtDetail>('debt.detail', { charge_id: chargeId })
  const bootstrap = useOperationsQuery<Bootstrap>('bootstrap', {})
  const mutation = useOperationsMutation()
  const [notice, setNotice] = useState('')
  const [methodId, setMethodId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [qrReady, setQRReady] = useState(false)
  const selectQR = useCallback(() => setConfirmed(false), [])
  const readyQR = useCallback((ready: boolean) => { setQRReady(ready); if (!ready) setConfirmed(false) }, [])
  const methods = bootstrap.data?.methods.filter((method) => method.code !== 'card') ?? []
  const selectedMethod = methods.find((method) => method.id === methodId) ?? methods.find((method) => method.code === 'cash') ?? methods[0]
  const transfer = selectedMethod?.code === 'transfer'
  const canSubmit = confirmed && !!selectedMethod && (!transfer || qrReady)

  const debt = detail.data
  return <Panel><SectionTitle title="Detalle e historial de pagos" /><QueryState {...detail} retry={detail.refresh} />
    {debt && <><p><strong>{debt.name}</strong> · {debt.phone}</p><p>Compra: {debt.purchased_on} · {debt.due_on ? `Vence: ${debt.due_on}` : 'Sin vencimiento'}</p>
      <ul>{debt.products.map((item, index) => <li key={index}>{item.quantity} × {item.name} · {money(Number(item.total))}</li>)}</ul>
      <p>Total: {money(Number(debt.total))} · Abono inicial: {money(Number(debt.initial_payment))} · Abonos posteriores: {money(Number(debt.paid) - Number(debt.initial_payment))} · Saldo: <strong>{money(Number(debt.outstanding))}</strong></p>
      {debt.returned && <p className="notice">Compra devuelta · Reintegro: {money(Number(debt.refund_amount))} · Deuda cancelada por devolución: {money(Number(debt.return_credit_reduction))}. La reducción por devolución no es un abono.</p>}
      <h3>Historial de pagos</h3><ul>{debt.receipts.map((receipt) => <li key={receipt.id}>{new Date(receipt.received_at).toLocaleString('es-CO')} · {receipt.kind === 'initial_payment' ? 'Pago inicial · ' : ''}{money(Number(receipt.amount))} · {receipt.method}{receipt.reference ? ` · ${receipt.reference}` : ''}</li>)}</ul>
      {notice && <p role="status">{notice}</p>}
      {Number(debt.outstanding) > 0 && <><QueryState {...bootstrap} retry={bootstrap.refresh} />
        {bootstrap.data?.session ? <form className="settings-form" onSubmit={async (event) => {
          event.preventDefault()
          if (!canSubmit) return
          const form = event.currentTarget
          const values = new FormData(form)
          if (await mutation.run('debt.receipt', { charge_id: chargeId, session_id: bootstrap.data?.session?.id,
            amount: values.get('amount'), method_id: selectedMethod?.id })) {
            form.reset(); setMethodId(''); setConfirmed(false); setQRReady(false); setNotice('Abono registrado en esta compra.'); detail.refresh(); bootstrap.refresh(); onChanged()
          }
        }} onChange={(event) => {
          if (!(event.target instanceof Element) || event.target.getAttribute('name') !== 'confirm_receipt') setConfirmed(false)
        }}><fieldset disabled={mutation.busy} className="business-fieldset">
          <p>El abono se aplica exclusivamente a esta compra, sin mezclar otras deudas de la persona.</p>
          <label className="form-label">Valor del abono<input name="amount" type="number" required min="0.01" max={debt.outstanding} step="0.01" /></label>
          <label className="form-label">Método<select name="method_id" required value={selectedMethod?.id ?? ''} onChange={(event) => { setMethodId(event.target.value); setConfirmed(false); setQRReady(false) }}>{methods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label>
          {transfer && <TransferPicker onSelect={selectQR} onReady={readyQR} />}
          <p className="muted">Verifica manualmente la recepción de las transferencias antes de registrar el abono.</p>
          <label className="checkbox-label"><input name="confirm_receipt" type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Confirmo el valor recibido.</label>
        </fieldset>{mutation.error && <p role="alert">{mutation.error}</p>}<Button type="submit" disabled={mutation.busy || !canSubmit}>{mutation.busy ? 'Registrando…' : 'Registrar abono recibido'}</Button></form>
          : bootstrap.data && <p>Abre tu propia caja desde <a href="#/pos">Punto de venta</a> para registrar abonos.</p>}
      </>}
    </>}
  </Panel>
}
