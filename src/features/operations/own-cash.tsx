import { Panel, SectionTitle } from '../../components/common'
import { OperationForm, AmountField } from './forms'
import { money } from '../../lib/utils'
import type { CashSession } from '../../../shared/operations'

export function OwnCash({ session, onChanged }: { session: CashSession | null; onChanged: () => void }) {
  return <Panel><SectionTitle title="Mi caja" subtitle="Solo puedes gestionar tu propia caja desde el punto de venta." />
    {session ? <><p>Caja {session.register_code} · Efectivo esperado: <strong>{money(session.expected)}</strong></p>
      <details><summary>Arqueo y cierre de mi caja</summary><OperationForm action="cash.close" defaults={{ session_id: session.id }} onDone={onChanged} label="Confirmar arqueo y cerrar mi caja">
        <AmountField name="counted" label="Efectivo contado" min="0" /><label className="checkbox-label"><input type="checkbox" required />Confirmo el arqueo de mi caja.</label>
      </OperationForm></details></> : <OperationForm action="cash.open" onDone={onChanged} label="Abrir mi caja">
      <label className="form-label">Código de caja<input name="register_code" required defaultValue="MAIN" maxLength={30} pattern="[A-Za-z0-9_-]{1,30}" /></label>
      <AmountField name="opening_float" label="Saldo inicial" min="0" defaultValue="0" />
    </OperationForm>}
  </Panel>
}
