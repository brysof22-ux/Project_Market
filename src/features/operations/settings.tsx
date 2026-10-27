import { useState } from 'react'
import { PageHeading, Panel, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { useAuth } from '../auth/context'
import { useOperationsMutation, useOperationsQuery } from '../catalog/hooks'
import { QueryState } from '../catalog/common'
import { OperationForm } from './forms'
import type { Bootstrap, StaffAccount, AuditEvent } from '../../../shared/operations'
import { WhatsAppSettings } from './whatsapp-settings'
import { TransferSettings } from '../payments/transfer-qr'
import { ResetOperation } from './reset'
import { PeriodHistory } from './period-history'

function UserForm({ user, done }: { user: StaffAccount | null; done: () => void }) {
  const mutation = useOperationsMutation()
  return <form className="settings-form" onSubmit={async (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget))
    if (await mutation.run('user.save', { ...values, active: values.active === 'on', can_credit: true, can_expenses: values.role === 'admin' })) done()
  }}>
    <p className="muted">El usuario debe existir en Supabase Auth. Aquí se administra su perfil de tienda; no se reciben contraseñas ni claves administrativas.</p>
    <label className="form-label">ID del usuario Auth<input name="id" required readOnly={!!user} defaultValue={user?.id} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" /></label>
    <label className="form-label">Nombre visible<input name="display_name" required maxLength={100} pattern=".*\S.*" defaultValue={user?.display_name} /></label>
    {user?.role === 'supervisor' && <p role="alert">Este perfil Supervisor se conserva pendiente de clasificación. Elige Administrador o Cajero explícitamente.</p>}
    <label className="form-label">Rol<select name="role" required defaultValue={user?.role === 'supervisor' ? '' : user?.role ?? 'cashier'}><option value="" disabled>Selecciona un rol</option><option value="cashier">Cajero</option><option value="admin">Administrador</option></select></label>
    <label className="checkbox-label"><input name="active" type="checkbox" defaultChecked={user?.active ?? true} />Usuario activo</label>
    <p className="muted">El cajero registra ventas y abonos, incluyendo ventas a crédito. No tiene permisos administrativos ni de gastos.</p>
    {mutation.error && <p role="alert">{mutation.error}</p>}<Button type="submit" disabled={mutation.busy}>Guardar perfil</Button>
  </form>
}
function Users() {
  const [offset, setOffset] = useState(0)
  const [editor, setEditor] = useState<{ user: StaffAccount | null } | null>(null)
  const query = useOperationsQuery<StaffAccount[]>('users.list', { offset, limit: 20 })
  return <Panel><SectionTitle title="Usuarios y permisos" /><QueryState {...query} retry={query.refresh} />
    <Button onClick={() => setEditor({ user: null })}>Agregar perfil existente</Button>
    <ul>{query.data?.map((user) => <li key={user.id}>{user.display_name} · {user.role} · {user.active ? 'Activo' : 'Inactivo'} <Button variant="ghost" onClick={() => setEditor({ user })}>Editar {user.display_name}</Button></li>)}</ul>
    <Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</Button><Button variant="outline" disabled={(query.data?.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>Siguiente</Button>
    {editor && <UserForm key={editor.user?.id ?? 'new'} user={editor.user} done={() => { setEditor(null); query.refresh() }} />}
  </Panel>
}
export function Settings({ dark, toggleTheme }: { dark: boolean; toggleTheme: () => void }) {
  const { profile } = useAuth()
  const query = useOperationsQuery<Bootstrap>('bootstrap', {})
  const [notice, setNotice] = useState('')
  return <><PageHeading title="Configuración" subtitle="Preferencias de la tienda y acceso de empleados." />
    <Panel><SectionTitle title="Apariencia" /><Button onClick={toggleTheme}>{dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}</Button></Panel>
    <QueryState {...query} retry={query.refresh} />{notice && <p role="status">{notice}</p>}
    {profile?.role === 'admin' && <>
      {query.data && <Panel><SectionTitle title="Información del negocio" /><OperationForm action="settings.save" onDone={() => { setNotice('Configuración guardada.'); query.refresh() }}>
        <label className="form-label">Nombre de la tienda<input name="name" required maxLength={80} pattern=".*\S.*" defaultValue={query.data.settings?.name ?? ''} /></label>
        <label className="form-label">Ubicación<input name="address" maxLength={160} defaultValue={query.data.settings?.address ?? ''} /></label>
        <p>COP · America/Bogota</p>
      </OperationForm></Panel>}
      <TransferSettings />
      <WhatsAppSettings />
      <Users />
      <ResetOperation />
      <PeriodHistory />
    </>}
  </>
}
export function Audit() {
  const [offset, setOffset] = useState(0)
  const query = useOperationsQuery<AuditEvent[]>('audit.list', { offset, limit: 20 })
  return <><PageHeading title="Auditoría" subtitle="Operaciones registradas con identidad y reloj del servidor." />
    <Panel><QueryState {...query} retry={query.refresh} /><div className="table-scroll"><table><thead><tr><th>FECHA</th><th>USUARIO</th><th>ACCIÓN</th><th>REGISTRO</th></tr></thead>
      <tbody>{query.data?.map((row) => <tr key={row.id}><td>{new Date(row.created_at).toLocaleString('es-CO')}</td><td title={row.actor_id}>{row.actor_name}</td><td>{row.action}</td><td>{row.entity_id}</td></tr>)}</tbody></table></div>
      <Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</Button><Button variant="outline" disabled={(query.data?.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>Siguiente</Button>
    </Panel>
  </>
}
