import { createContext } from 'react'
import type { DemoRole, DemoSale, PaymentActor, TransferMethod } from './types'
import type { saveTransferMethod } from './repository'

export type PaymentsContextValue = {
  actor: PaymentActor
  setDemoRole: (role: DemoRole) => void
  methods: TransferMethod[]
  sales: DemoSale[]
  ready: boolean
  error: string
  refresh: () => Promise<void>
  saveMethod: (
    input: Parameters<typeof saveTransferMethod>[1],
    image?: Blob,
  ) => Promise<void>
  commitSale: (sale: DemoSale) => Promise<void>
}
export const PaymentsContext = createContext<PaymentsContextValue | null>(null)
