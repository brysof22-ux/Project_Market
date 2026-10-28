import { Button } from '../../components/ui/button'

export function QueryState({ loading, error, retry }: { loading: boolean; error: string; retry: () => void }) {
  if (loading) return <div role="status" className="query-loading"><span className="loading-indicator" aria-hidden="true" /><span>Cargando información…</span><div className="skeleton-lines" aria-hidden="true"><i /><i /><i /></div></div>
  if (!error) return null
  return <div role="alert" className="notice">{error} <Button variant="outline" onClick={retry}>Reintentar</Button></div>
}
export function Pagination({ offset, total, size = 20, onChange }: { offset: number; total: number; size?: number; onChange: (offset: number) => void }) {
  return <div className="table-footer">
    <span>{total ? offset + 1 : 0}–{Math.min(offset + size, total)} de {total} registros</span>
    <Button variant="outline" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - size))}>Anterior</Button>
    <Button variant="outline" disabled={offset + size >= total} onClick={() => onChange(offset + size)}>Siguiente</Button>
  </div>
}
