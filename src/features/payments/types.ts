export type DemoRole = 'admin' | 'supervisor' | 'cashier'
export type PaymentActor = { id: string; name: string; role: DemoRole }
export type TransferMethod = {
  id: string
  name: string
  institution: string
  holder: string
  imagePath: string
  active: boolean
  revision: number
  updatedAt: string
  updatedBy: string
}
export type TransferDraft = {
  methodId: string
  revision: number
  amountMinor: number
  reference: string
  confirmedBy: PaymentActor
  confirmedAt: string
  confirmation: 'manual-demo'
}
export type DemoPayment = {
  kind: 'cash' | 'card' | 'transfer'
  amountMinor: number
  transfer?: TransferDraft & {
    methodName: string
    institution: string
    holder: string
    imagePath: string
  }
}
export type DemoSale = {
  id: string
  operationKey: string
  confirmedAt: string
  actor: PaymentActor
  totalMinor: number
  items: { productId: string; quantity: number; unitPriceMinor: number }[]
  payments: DemoPayment[]
  mode: 'demo'
}
export type MethodChange = {
  id: string
  methodId: string
  actor: PaymentActor
  at: string
  before: TransferMethod | null
  after: TransferMethod
}

/** Future Worker contract. Actor and timestamp MUST be derived by the server. */
export type ConfirmSaleRequest = {
  idempotencyKey: string
  items: { productId: string; quantity: number }[]
  payments: (
    | { kind: 'cash' | 'card'; amount: string }
    | {
        kind: 'transfer'
        amount: string
        transferMethodId: string
        expectedRevision: number
        reference: string
        manuallyVerified: true
      }
  )[]
}

export const MAX_QR_BYTES = 2 * 1024 * 1024
export const formatPaymentMoney = (minor: number) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100)
export function parseMinor(value: string) {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value.trim())) return null
  const [whole, decimals = ''] = value.trim().replace(',', '.').split('.')
  const result = Number(whole) * 100 + Number(decimals.padEnd(2, '0'))
  return Number.isSafeInteger(result) && result >= 0 ? result : null
}
