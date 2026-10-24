import { createContext, useContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { StaffProfile } from '../../../shared/profile'

export type AuthContextValue = {
  session: Session | null
  profile: StaffProfile | null
  loading: boolean
  error: string
  configurationError: string
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  retry: () => void
}
export const AuthContext = createContext<AuthContextValue | null>(null)
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth requiere AuthProvider.')
  return value
}
