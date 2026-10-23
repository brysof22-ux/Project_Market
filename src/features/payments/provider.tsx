import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { PaymentsContext } from './context'
import {
  commitDemoSale,
  listDemoSales,
  listTransferMethods,
  saveTransferMethod,
} from './repository'
import type { DemoRole, DemoSale, PaymentActor, TransferMethod } from './types'

const actors: Record<DemoRole, PaymentActor> = {
  admin: { id: 'demo-admin', name: 'Daniel Gómez', role: 'admin' },
  supervisor: {
    id: 'demo-supervisor',
    name: 'Supervisor de ejemplo',
    role: 'supervisor',
  },
  cashier: { id: 'demo-cashier', name: 'Cajero de ejemplo', role: 'cashier' },
}
function initialActor() {
  try {
    const role = sessionStorage.getItem('cai-market:demo-role')
    if (role === 'admin' || role === 'supervisor' || role === 'cashier')
      return actors[role]
  } catch {
    /* No persistent browser session. */
  }
  return actors.admin
}
export function PaymentsProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState(initialActor)
  const actorRef = useRef(actor)
  const [methods, setMethods] = useState<TransferMethod[]>([])
  const [sales, setSales] = useState<DemoSale[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      const [nextMethods, nextSales] = await Promise.all([
        listTransferMethods(),
        listDemoSales(),
      ])
      setMethods(nextMethods)
      setSales(nextSales)
      setError('')
      setReady(true)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Almacenamiento local no disponible.',
      )
      setReady(false)
    }
  }, [])
  useEffect(() => {
    void Promise.resolve().then(refresh)
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    const channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('cai-payments-demo')
        : null
    if (channel) channel.onmessage = onFocus
    return () => {
      window.removeEventListener('focus', onFocus)
      channel?.close()
    }
  }, [refresh])
  function notifyChange() {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('cai-payments-demo')
      channel.postMessage('changed')
      channel.close()
    }
  }
  function setDemoRole(role: DemoRole) {
    actorRef.current = actors[role]
    setActor(actors[role])
    try {
      sessionStorage.setItem('cai-market:demo-role', role)
    } catch {
      /* Role remains in memory. */
    }
  }
  return (
    <PaymentsContext.Provider
      value={{
        actor,
        setDemoRole,
        methods,
        sales,
        ready,
        error,
        refresh,
        saveMethod: async (input, image) => {
          await saveTransferMethod(actorRef.current, input, image)
          await refresh()
          notifyChange()
        },
        commitSale: async (sale) => {
          await commitDemoSale(sale)
          await refresh()
          notifyChange()
        },
      }}
    >
      {children}
    </PaymentsContext.Provider>
  )
}
