import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import { Button } from '../../components/ui/button'
import type { Bootstrap } from '../../../shared/operations'
import { PeriodContext } from './period-context'

// Pin the period for this mounted application. An old cart must never silently
// become a sale in a new period after another administrator resets operations.
export function OperationPeriod({ children }: { children: ReactNode }) {
  const [period, setPeriod] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void api.operations<Bootstrap>('bootstrap', {}, undefined, controller.signal).then((result) => {
      if (!controller.signal.aborted && result.period_id) setPeriod(result.period_id)
      else if (!controller.signal.aborted) setFailed(true)
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [])
  if (!period) return <div role={failed ? 'alert' : 'status'}>{failed ? <><p>No se pudo verificar el período operativo. No se habilitaron operaciones.</p><Button onClick={() => window.location.reload()}>Volver a comprobar</Button></> : 'Verificando período operativo…'}</div>
  return <PeriodContext value={period}>{children}</PeriodContext>
}
