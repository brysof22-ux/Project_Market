import { useState, type FormEvent } from 'react'
import { AlertTriangle, Clock3, ShieldCheck } from 'lucide-react'
import { Panel, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { useAuth } from '../auth/context'
import { getSupabaseClient } from '../../lib/supabase'
import { api } from '../../lib/api'
import { ApiError } from '../../lib/api-client'
import { useOperationsMutation } from '../catalog/hooks'
import { useOperationPeriod } from './period-context'
import { money } from '../../lib/utils'
import type { ResetPreview } from '../../../shared/operations'

export function ResetOperation() {
  const { session } = useAuth()
  const period = useOperationPeriod()
  const [preview, setPreview] = useState<ResetPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mutation = useOperationsMutation()
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const input = form.elements.namedItem('password') as HTMLInputElement
    const password = input.value
    input.value = ''
    setBusy(true); setError(''); setPreview(null)
    try {
      if (!session?.user.email) throw new Error()
      // A real password sign-in updates Supabase's signed AMR. A refresh, iat,
      // local boolean or client clock is never evidence of recent identity.
      const { data, error: authError } = await getSupabaseClient().auth.signInWithPassword({ email: session.user.email, password })
      if (authError || data.user?.id !== session.user.id) { setError('No se pudo confirmar tu identidad. Revisa tu contraseña.'); return }
      const next = await api.operations<ResetPreview>('reset.preview', { expected_period: period })
      if (next.period_id !== period) { setError('El período cambió. Recarga la aplicación antes de continuar.'); return }
      setPreview(next)
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : 'No se pudo verificar el reinicio. No se realizaron cambios.') }
    finally { setBusy(false) }
  }
  return <Panel className="reset-panel"><SectionTitle title="Administración · Reiniciar operación" subtitle="Revisa el alcance antes de autorizar una eliminación permanente." />
    <div className="reset-warning"><AlertTriangle size={22} aria-hidden="true"/><div><strong>Esta acción es irreversible</strong><p>Elimina permanentemente todas las ventas, pagos, devoluciones, deudas, abonos, movimientos de caja y notificaciones comerciales de todos los períodos. No se archivan ni se respaldan.</p></div></div>
    <p className="reset-description">Conserva usuarios, clientes, proveedores, productos, fotos, precios, mínimos, métodos de pago, QR y configuración. Las existencias quedan en cero y la siguiente venta será V-1.</p>
    <p className="muted">El borrado no elimina obligaciones de conservación de información que resulten aplicables.</p>
    <form className="settings-form" onSubmit={verify}>
      <h3 className="reset-step"><ShieldCheck size={19} aria-hidden="true"/>1. Verifica tu identidad</h3>
      <label className="form-label">Confirma tu contraseña<input name="password" type="password" required autoComplete="current-password" disabled={busy || mutation.busy} /></label>
      <Button type="submit" variant="outline" disabled={busy || mutation.busy}>{busy ? 'Verificando identidad…' : 'Verificar identidad y revisar alcance'}</Button>
    </form>
    {error && <p role="alert">{error}</p>}
    {preview && <form className="settings-form" onSubmit={async (event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget)
      if (await mutation.run('reset.confirm', { intent_id: preview.intent_id, expected_period: preview.period_id,
        confirmation: data.get('confirmation'), reason: data.get('reason') })) window.location.reload()
    }}><fieldset disabled={mutation.busy} className="business-fieldset reset-confirmation">
      <h3 className="reset-step">2. Revisa los datos afectados</h3>
      <p className="muted">Período: <code className="record-id">{preview.period_id}</code></p>
      <dl className="reset-summary">{[['Ventas',preview.sales],['Deudas',preview.debts],['Saldo por eliminar',money(Number(preview.outstanding))],['Existencias que pasarán a cero',preview.stock],['Cajas abiertas',preview.open_sessions]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="reset-expiry"><Clock3 size={16} aria-hidden="true"/><span>Confirmación válida hasta {new Date(preview.expires_at).toLocaleTimeString('es-CO')}. Si los datos cambian, debes revisar el alcance nuevamente.</span></p>
      {preview.open_sessions > 0 && <p role="alert">Las cajas abiertas también se eliminarán al confirmar.</p>}
      <h3 className="reset-step">3. Autoriza el reinicio</h3>
      <label className="form-label">Motivo del reinicio<input name="reason" required minLength={5} maxLength={500} pattern=".*\S.*" /></label>
      <label className="form-label">Escribe ELIMINAR OPERACION<input name="confirmation" required pattern="ELIMINAR OPERACION" autoComplete="off" /></label>
      <label className="checkbox-label"><input type="checkbox" required />He revisado el alcance y autorizo eliminar permanentemente la operación comercial.</label>
    </fieldset>{mutation.error && <p role="alert">{mutation.error}</p>}
      <Button type="submit" className="button-destructive" disabled={mutation.busy}>{mutation.busy ? 'Reiniciando de forma atómica…' : 'Eliminar operación permanentemente'}</Button>
    </form>}
  </Panel>
}
