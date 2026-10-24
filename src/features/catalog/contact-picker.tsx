import { useState } from 'react'
import { useCatalogQuery, useSearch } from './hooks'
import { QueryState } from './common'
import type { DirectoryPage } from '../../../shared/catalog'

export function ContactPicker({ name = 'customer_id', label = 'Cliente', required = false, supplier = false, defaultId = '' }: {
  name?: string; label?: string; required?: boolean; supplier?: boolean; defaultId?: string
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(defaultId)
  const settledSearch = useSearch(search)
  const query = useCatalogQuery<DirectoryPage>('directories.list', { search: settledSearch, limit: 100 })
  const rows = (supplier ? query.data?.suppliers : query.data?.customers)?.filter((row) => row.active) ?? []
  return <><label className="form-label">Buscar {label.toLowerCase()}<input aria-label={`Buscar ${label.toLowerCase()} para operación`} value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
    <QueryState {...query} retry={query.refresh} />
    <label className="form-label">{label}<select name={name} required={required} value={selected} onChange={(event) => setSelected(event.target.value)}>
      <option value="">{required ? `Selecciona ${label.toLowerCase()}` : `Sin ${label.toLowerCase()}`}</option>
      {selected && !rows.some((row) => row.id === selected) && <option value={selected}>Selección actual</option>}
      {rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
    </select></label>
  </>
}
