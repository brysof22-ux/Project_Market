import { createApiClient, ApiError } from './api-client'
import { getSupabaseClient } from './supabase'

export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL?.trim() ?? '',
  getSession: async () => {
    const { data, error } = await getSupabaseClient().auth.getSession()
    if (error) throw new ApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida. Inicia sesión de nuevo.')
    return data.session
  },
})
