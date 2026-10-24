import { type ReactNode } from 'react'
import { Button } from '../../components/ui/button'
import { useOperationsMutation } from '../catalog/hooks'
import type { OperationAction } from '../../../shared/operations'
export { ContactPicker } from '../catalog/contact-picker'

export function OperationForm({ action, defaults = {}, children, label = 'Guardar operación', onDone }: {
  action: OperationAction; defaults?: Record<string, unknown>; children: ReactNode; label?: string; onDone: () => void
}) {
  const mutation = useOperationsMutation()
  return <form className="settings-form" onSubmit={async (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget))
    if (await mutation.run(action, { ...defaults, ...values })) onDone()
  }}>
    <fieldset disabled={mutation.busy} className="business-fieldset">{children}</fieldset>
    {mutation.error && <p role="alert">{mutation.error}</p>}
    <Button type="submit" disabled={mutation.busy}>{mutation.busy ? 'Guardando…' : label}</Button>
  </form>
}
export function AmountField({ name = 'amount', label = 'Valor', min = '0.01', defaultValue }: { name?: string; label?: string; min?: string; defaultValue?: string | number }) {
  return <label className="form-label">{label}<input name={name} type="number" required min={min} max="1000000000000" step="0.01" defaultValue={defaultValue} /></label>
}
