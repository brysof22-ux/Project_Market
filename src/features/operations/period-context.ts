import { createContext, useContext } from 'react'
export const PeriodContext = createContext<string | null>(null)
export function useOperationPeriod() { return useContext(PeriodContext) }
