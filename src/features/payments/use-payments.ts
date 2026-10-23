import { useContext } from 'react'
import { PaymentsContext } from './context'

export function usePayments() {
  const value = useContext(PaymentsContext)
  if (!value) throw new Error('PaymentsProvider es obligatorio.')
  return value
}
