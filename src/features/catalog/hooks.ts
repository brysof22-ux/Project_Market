import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { ApiError } from '../../lib/api-client'
import type { CatalogAction } from '../../../shared/catalog'
import type { OperationAction } from '../../../shared/operations'

function useRemoteQuery<T>(section: 'catalog' | 'operations', action: CatalogAction | OperationAction, parameters: Record<string, unknown>) {
  const serialized = JSON.stringify(parameters)
  const [revision, setRevision] = useState(0)
  const queryKey = `${section}:${action}:${serialized}:${revision}`
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({ key: '', data: null, error: '' })
  useEffect(() => {
    const controller = new AbortController()
    const request = section === 'catalog'
      ? api.catalog<T>(action as CatalogAction, JSON.parse(serialized), undefined, controller.signal)
      : api.operations<T>(action as OperationAction, JSON.parse(serialized), undefined, controller.signal)
    void request.then((data) => {
      if (!controller.signal.aborted) setState({ key: queryKey, data, error: '' })
    }).catch((cause) => {
      if (!controller.signal.aborted) setState({ key: queryKey, data: null,
        error: cause instanceof ApiError ? cause.message : 'No se pudo cargar la información.' })
    })
    return () => controller.abort()
  }, [section, action, serialized, queryKey])
  return { data: state.key === queryKey ? state.data : null, loading: state.key !== queryKey,
    error: state.key === queryKey ? state.error : '', refresh: useCallback(() => setRevision((value) => value + 1), []) }
}

function useRemoteMutation<A extends CatalogAction | OperationAction>(section: 'catalog' | 'operations') {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ signature: string; key: string } | null>(null)
  const running = useRef(false)
  const run = async (action: A, data: Record<string, unknown>) => {
    if (running.current) return false
    const signature = JSON.stringify({ action, data })
    if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() }
    running.current = true
    setBusy(true)
    setError('')
    try {
      if (section === 'catalog') await api.catalog(action as CatalogAction, data, pending.current.key)
      else await api.operations(action as OperationAction, data, pending.current.key)
      pending.current = null
      return true
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'No se pudo guardar la operación.')
      return false
    } finally { running.current = false; setBusy(false) }
  }
  return { busy, error, run }
}

export function useCatalogQuery<T>(action: CatalogAction, parameters: Record<string, unknown>) { return useRemoteQuery<T>('catalog', action, parameters) }
export function useOperationsQuery<T>(action: OperationAction, parameters: Record<string, unknown>) { return useRemoteQuery<T>('operations', action, parameters) }
export function useCatalogMutation() { return useRemoteMutation<CatalogAction>('catalog') }
export function useOperationsMutation() { return useRemoteMutation<OperationAction>('operations') }

export function useSearch(value: string) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), 200)
    return () => clearTimeout(timer)
  }, [value])
  return settled
}
