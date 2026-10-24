import { useState } from 'react'
import { PageHeading, Panel, EmptyState, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { useOperationsQuery } from '../catalog/hooks'
import { QueryState } from '../catalog/common'
import { AmountField, OperationForm } from './forms'
import { money } from '../../lib/utils'
import type { Bootstrap, CashSession } from '../../../shared/operations'

export function Accounting() {
  const bootstrap = useOperationsQuery<Bootstrap>('bootstrap', {})
  const [offset, setOffset] = useState(0)
  const history = useOperationsQuery<CashSession[]>('cash.list', { limit: 20, offset })
  const [notice, setNotice] = useState('')
  const [entries, setEntries] = useState<string | null>(null)
  const done = () => { setNotice('Operación de caja registrada.'); bootstrap.refresh(); history.refresh() }
  const session = bootstrap.data?.session
  return <>
    <PageHeading title="Contabilidad" subtitle="Caja y control financiero operativo. No constituye contabilidad tributaria.">
      <Button variant="outline" onClick={() => { bootstrap.refresh(); history.refresh() }}>Actualizar caja</Button>
    </PageHeading>
    {notice && <p role="status">{notice}</p>}
    <QueryState {...bootstrap} retry={bootstrap.refresh} />
    {bootstrap.data && <div className="settings-grid">
      <Panel><SectionTitle title={session ? 'Caja abierta' : 'Abrir caja'} />
        {session ? <><p>Registro: {session.register_code}</p><p>Apertura: {money(session.opening_float)}</p><p>Efectivo esperado: <strong>{money(session.expected)}</strong></p>
          <OperationForm action="cash.close" defaults={{ session_id: session.id }} onDone={done} label="Confirmar arqueo y cerrar caja">
            <AmountField name="counted" label="Efectivo contado" min="0" />
            <p className="muted">El cierre conserva el esperado y la diferencia del arqueo.</p>
          </OperationForm>
        </> : <OperationForm action="cash.open" onDone={done} label="Abrir caja">
          <label className="form-label">Código de caja<input name="register_code" defaultValue="MAIN" required pattern="[A-Za-z0-9_-]{1,30}" maxLength={30} /></label>
          <AmountField name="opening_float" label="Saldo inicial" min="0" />
        </OperationForm>}
      </Panel>
      {session && bootstrap.data.permissions.expenses && <Panel><SectionTitle title="Ingresos y egresos de efectivo" subtitle="Ajustes de caja distintos de ventas y abonos." />
        <OperationForm action="cash.move" defaults={{ session_id: session.id }} onDone={done}>
          <label className="form-label">Tipo<select name="kind"><option value="expense">Gasto / egreso</option><option value="income">Ingreso extraordinario</option></select></label>
          <AmountField /><label className="form-label">Motivo<input name="reason" required pattern=".*\S.*" maxLength={500} /></label>
        </OperationForm>
      </Panel>}
    </div>}
    <Panel><SectionTitle title="Historial de cajas" subtitle="Cajas accesibles con tu rol, en páginas de 20 registros." /><QueryState {...history} retry={history.refresh} />
      <div className="table-scroll"><table><thead><tr><th>CAJA</th><th>APERTURA</th><th>CIERRE</th><th>ESPERADO</th><th>CONTADO</th><th>DIFERENCIA</th><th>MOVIMIENTOS</th></tr></thead>
        <tbody>{history.data?.map((row) => <tr key={row.id}><td>{row.register_code}</td><td>{new Date(row.opened_at).toLocaleString('es-CO')}</td><td>{row.closed_at ? new Date(row.closed_at).toLocaleString('es-CO') : 'Abierta'}</td>
          <td>{row.expected === null ? '—' : money(row.expected)}</td><td>{row.counted == null ? '—' : money(row.counted)}</td><td>{row.difference == null ? '—' : money(row.difference)}</td>
          <td><Button variant="ghost" onClick={() => setEntries(row.id)}>Ver movimientos</Button></td></tr>)}</tbody></table></div>
      {history.data?.length === 0 && <EmptyState text="No hay cajas registradas." />}
      <Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</Button>
      <Button variant="outline" disabled={(history.data?.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>Siguiente</Button>
    </Panel>
    {entries && <CashEntries sessionId={entries} />}
  </>
}
function CashEntries({ sessionId }: { sessionId: string }) {
  const [offset, setOffset] = useState(0)
  const query = useOperationsQuery<{ id: string; amount: number; kind: string; created_at: string }[]>('cash.entries', { session_id: sessionId, offset, limit: 20 })
  return <Panel><SectionTitle title="Movimientos de efectivo" /><QueryState {...query} retry={query.refresh} />
    <ul>{query.data?.map((row) => <li key={row.id}>{new Date(row.created_at).toLocaleString('es-CO')} · {row.kind} · {money(row.amount)}</li>)}</ul>
    {!query.data?.length && !query.loading && !query.error && <EmptyState text="Sin movimientos de efectivo." />}
    <Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</Button>
    <Button variant="outline" disabled={(query.data?.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>Siguiente</Button>
  </Panel>
}
