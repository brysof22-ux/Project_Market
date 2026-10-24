import { useState } from 'react'
import { Badge, EmptyState, PageHeading, Panel } from '../../components/common'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { useAuth } from '../auth/context'
import { useCatalogMutation, useCatalogQuery, useSearch } from './hooks'
import { Pagination, QueryState } from './common'
import type { Contact, DirectoryPage } from '../../../shared/catalog'
import { SalesHistory } from '../operations/sales'

function ContactEditor({ contact, supplier, done }: { contact: Contact | null; supplier: boolean; done: () => void }) {
  const mutation = useCatalogMutation()
  return <form className="settings-form" onSubmit={async (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget))
    if (await mutation.run(supplier ? 'supplier.save' : 'customer.save', {
      ...values, active: values.active === 'on', ...(contact ? { id: contact.id, version: contact.version } : {}),
    })) done()
  }}>
    <label className="form-label">Nombre<input name="name" required maxLength={160} pattern=".*\S.*" defaultValue={contact?.name} /></label>
    <label className="form-label">Correo<input name="email" type="email" maxLength={160} defaultValue={contact?.email} /></label>
    <label className="form-label">Teléfono<input name="phone" type="tel" maxLength={40} defaultValue={contact?.phone} /></label>
    <label className="checkbox-label"><input name="active" type="checkbox" defaultChecked={contact?.active ?? true} />Activo</label>
    {mutation.error && <p role="alert">{mutation.error}</p>}
    <Button disabled={mutation.busy} type="submit">{mutation.busy ? 'Guardando…' : 'Guardar contacto'}</Button>
  </form>
}
export function Directory({ type }: { type: 'clientes' | 'proveedores' }) {
  const supplier = type === 'proveedores'
  const { profile } = useAuth()
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [editor, setEditor] = useState<{ contact: Contact | null } | null>(null)
  const [saved, setSaved] = useState(false)
  const [history, setHistory] = useState<Contact | null>(null)
  const settledSearch = useSearch(search)
  const query = useCatalogQuery<DirectoryPage>('directories.list', { search: settledSearch, offset, limit: 20 })
  if (supplier && profile?.role === 'cashier') return <p role="alert">No tienes permiso para administrar proveedores.</p>
  const rows = supplier ? query.data?.suppliers : query.data?.customers
  const total = (supplier ? query.data?.suppliers_total : query.data?.customers_total) ?? 0
  return <>
    <PageHeading title={supplier ? 'Proveedores' : 'Clientes'} subtitle="Directorio registrado en la tienda.">
      <Button onClick={() => setEditor({ contact: null })}>{supplier ? 'Nuevo proveedor' : 'Nuevo cliente'}</Button>
    </PageHeading>
    {saved && <p role="status">Contacto guardado.</p>}
    <Panel><div className="table-toolbar"><label className="search-field"><input aria-label={`Buscar ${type}`} value={search} maxLength={100} onChange={(event) => { setSearch(event.target.value); setOffset(0) }} placeholder="Buscar por nombre…" /></label></div>
      <QueryState {...query} retry={query.refresh} />
      {rows && <><div className="table-scroll"><table><thead><tr><th>NOMBRE</th><th>CORREO</th><th>TELÉFONO</th><th>ESTADO</th><th>ACCIONES</th></tr></thead>
        <tbody>{rows.map((contact) => <tr key={contact.id}><td><strong>{contact.name}</strong></td><td>{contact.email || '—'}</td><td>{contact.phone || '—'}</td>
          <td><Badge tone={contact.active ? 'green' : 'neutral'}>{contact.active ? 'Activo' : 'Inactivo'}</Badge></td><td><Button variant="ghost" onClick={() => setEditor({ contact })}>Editar {contact.name}</Button>
            {!supplier && <Button variant="ghost" onClick={() => setHistory(contact)}>Compras de {contact.name}</Button>}</td></tr>)}</tbody></table>
        {!rows.length && <EmptyState text="No hay contactos registrados para esta búsqueda." />}</div><Pagination offset={offset} total={total} onChange={setOffset} /></>}
    </Panel>
    {!supplier && history && <SalesHistory key={history.id} customerId={history.id} title={`Compras de ${history.name}`} />}
    {editor && <Dialog open onOpenChange={(open) => { if (!open) setEditor(null) }} title={editor.contact ? 'Editar contacto' : supplier ? 'Nuevo proveedor' : 'Nuevo cliente'} description="Información de contacto para las operaciones de la tienda.">
      <ContactEditor contact={editor.contact} supplier={supplier} done={() => { setEditor(null); setSaved(true); query.refresh() }} />
    </Dialog>}
  </>
}
