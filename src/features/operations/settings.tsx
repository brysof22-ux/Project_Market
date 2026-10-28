import {useFormLeaveGuard} from './settings-guard'
import {Store,ShoppingCart,Package,Wallet,MessageCircle,ShieldCheck,Database,ChevronRight,AlertTriangle,CheckCircle2} from 'lucide-react'
import { useState } from 'react'
import { Badge, EmptyState, PageHeading, Panel, SectionTitle } from '../../components/common'
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
  return <Panel><SectionTitle title="Usuarios y permisos" subtitle="Administra el acceso de los perfiles registrados en tu tienda." action={<Button onClick={() => setEditor({ user: null })}>Agregar perfil existente</Button>} /><QueryState {...query} retry={query.refresh} />
    <ul className="user-list">{query.data?.map((user) => <li className="user-row" key={user.id}>
      <div className="user-identity"><span className="user-initial" aria-hidden="true">{user.display_name.slice(0,1).toUpperCase()}</span><div><strong>{user.display_name}</strong><small>{{admin:'Administrador',cashier:'Cajero',supervisor:'Supervisor'}[user.role]}</small></div></div>
      <Badge tone={user.active?'green':'neutral'}>{user.active ? 'Activo' : 'Inactivo'}</Badge><Button variant="outline" size="sm" onClick={() => setEditor({ user })}>Editar {user.display_name}</Button>
    </li>)}</ul>
    {query.data?.length===0&&<EmptyState text="No hay perfiles para mostrar en esta página."/>}
    <div className="table-footer"><span>Página {offset/20+1}</span><div className="heading-actions"><Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</Button><Button variant="outline" disabled={(query.data?.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>Siguiente</Button></div></div>
    {editor && <section className="user-editor" aria-label="Editor de perfil"><h3>{editor.user?'Editar perfil':'Agregar perfil existente'}</h3><UserForm key={editor.user?.id ?? 'new'} user={editor.user} done={() => { setEditor(null); query.refresh() }} /></section>}
  </Panel>
}
const settingGroups=[{id:'business',title:'Mi negocio',description:'Información comercial y apariencia',icon:Store},{id:'sales',title:'Ventas',description:'Métodos de pago y QR de transferencia',icon:ShoppingCart},{id:'inventory',title:'Inventario',description:'Productos, costos y stock mínimo',icon:Package},{id:'cash',title:'Caja y finanzas',description:'Apertura, cierre y movimientos',icon:Wallet},{id:'whatsapp',title:'WhatsApp',description:'Conexión, consentimiento y avisos',icon:MessageCircle},{id:'security',title:'Usuarios y seguridad',description:'Perfiles y permisos de acceso',icon:ShieldCheck},{id:'maintenance',title:'Datos y mantenimiento',description:'Períodos y operaciones avanzadas',icon:Database}] as const
export function Settings({dark,toggleTheme}:{dark:boolean;toggleTheme:()=>void}) {
 const {profile}=useAuth();const query=useOperationsQuery<Bootstrap>('bootstrap',{});const [group,setGroup]=useState<string>('business'),[notice,setNotice]=useState('');const guard=useFormLeaveGuard()
 const selected=settingGroups.find(x=>x.id===group)!
 return <div onChangeCapture={guard.onChangeCapture} onSubmitCapture={guard.onSubmitCapture}><PageHeading title="Configuración" subtitle="Encuentra los ajustes de tu negocio, organizados por tarea."/>
 {guard.dirty&&<p role="status" className="notice settings-unsaved"><AlertTriangle size={18} aria-hidden="true"/>Tienes cambios sin guardar.</p>}{notice&&<p role="status" className="settings-notice"><CheckCircle2 size={18} aria-hidden="true"/>{notice}</p>}
 <div className="settings-layout"><aside className="settings-sidebar" aria-label="Grupos de configuración"><p className="settings-nav-heading">Administrar tu tienda</p><div className="settings-navigation">{settingGroups.map(item=><button key={item.id} className="settings-group" aria-label={`${item.title} ${item.description}`} aria-controls="settings-panel" aria-pressed={group===item.id} onClick={()=>{if(group!==item.id&&guard.approve()){setGroup(item.id);setNotice('')}}}><item.icon size={19} aria-hidden="true"/><span><strong>{item.title}</strong><small>{item.description}</small></span><ChevronRight className="settings-nav-chevron" size={15} aria-hidden="true"/></button>)}</div></aside>
 <section id="settings-panel" aria-label={selected.title} className="settings-content"><header className="settings-selection-header"><span className="settings-selection-icon"><selected.icon size={22} aria-hidden="true"/></span><div><h2 className="settings-heading">{selected.title}</h2><p className="muted">{selected.description}</p></div></header>
 {profile?.role==='admin'&&<>
 {group==='business'&&<><QueryState {...query} retry={query.refresh}/>{query.data&&<Panel><SectionTitle title="Información del negocio" subtitle="Los datos que identifican tu tienda."/><OperationForm key={query.data.settings?.version??0} action="settings.save" defaults={{version:query.data.settings?.version??0}} label="Guardar cambios" onDone={()=>{setNotice('Configuración guardada correctamente.');query.refresh()}}><label className="form-label">Nombre de la tienda<input name="name" required maxLength={80} pattern=".*\S.*" defaultValue={query.data.settings?.name??''}/></label><label className="form-label">Ubicación<input name="address" maxLength={160} defaultValue={query.data.settings?.address??''}/></label><dl className="settings-meta"><div><dt>Moneda</dt><dd>COP · Peso colombiano</dd></div><div><dt>Zona horaria comercial</dt><dd>America/Bogota</dd></div></dl><p className="muted">La moneda y la zona horaria se mantienen fijas para conservar registros consistentes.</p></OperationForm></Panel>}<Panel className="settings-appearance"><SectionTitle title="Apariencia" subtitle="Preferencia guardada automáticamente en este dispositivo."/><Button variant="outline" onClick={toggleTheme}>{dark?'Cambiar a modo claro':'Cambiar a modo oscuro'}</Button></Panel></>}
 {group==='sales'&&<><Panel><SectionTitle title="Preferencias de venta"/><p>Efectivo, transferencia y ventas a crédito con confirmación manual. La numeración se asigna automáticamente.</p></Panel><TransferSettings/></>}
 {group==='inventory'&&<Panel><SectionTitle title="Preferencias de productos"/><dl className="detail-list"><div><dt>Stock mínimo inicial</dt><dd>5 unidades; editable en cada producto</dd></div><div><dt>Costos</dt><dd>Promedio ponderado al registrar una compra</dd></div><div><dt>Alertas</dt><dd>Productos en su mínimo o por debajo</dd></div></dl><div className="settings-quick-links"><Button asChild><a href="#/inventario">Administrar inventario</a></Button><Button asChild variant="outline"><a href="#/inventario?stock=bajo">Consultar stock bajo</a></Button></div></Panel>}
 {group==='cash'&&<Panel><SectionTitle title="Administración de cajas" subtitle="Gestiona tu sesión, sus movimientos y los arqueos en Contabilidad."/><p>Los cierres conservan efectivo esperado, contado, diferencia y observaciones. Las transferencias se registran por separado.</p><Button asChild><a href="#/contabilidad">Ir a Contabilidad</a></Button></Panel>}
 {group==='whatsapp'&&<WhatsAppSettings/>}
 {group==='security'&&<Users/>}
 {group==='maintenance'&&<><Panel><SectionTitle title="Exportación de información" subtitle="Descarga los reportes disponibles desde cada módulo."/><div className="heading-actions"><Button asChild variant="outline"><a href="#/estadisticas">Exportar reporte de estadísticas</a></Button><Button asChild variant="outline"><a href="#/contabilidad">Exportar historial de cajas</a></Button></div></Panel><PeriodHistory/><div className="danger-zone"><div className="danger-zone-heading"><AlertTriangle size={21} aria-hidden="true"/><h3>Operaciones avanzadas · zona de peligro</h3></div><p>Acceso exclusivo de administradores. El reinicio requiere reautenticación y confirmación explícita.</p><ResetOperation/></div></>}
 </>}
 </section></div></div>
}
export function Audit() {
  const [offset, setOffset] = useState(0)
  const query = useOperationsQuery<AuditEvent[]>('audit.list', { offset, limit: 20 })
  return <><PageHeading title="Auditoría" subtitle="Operaciones registradas con identidad y reloj del servidor." />
    <Panel><SectionTitle title="Registro de actividad" subtitle="Consulta quién realizó cada operación y el registro asociado."/><QueryState {...query} retry={query.refresh} /><div className="table-scroll" tabIndex={0} role="region" aria-label="Registro de auditoría"><table><thead><tr><th>FECHA</th><th>USUARIO</th><th>ACCIÓN</th><th>REGISTRO</th></tr></thead>
      <tbody>{query.data?.map((row) => <tr key={row.id}><td>{new Date(row.created_at).toLocaleString('es-CO')}</td><td title={row.actor_id}>{row.actor_name}</td><td><Badge tone="neutral">{row.action}</Badge></td><td><code className="record-id">{row.entity_id}</code></td></tr>)}</tbody></table>{query.data?.length===0&&<EmptyState text="No hay operaciones registradas para mostrar en esta página."/>}</div>
      <div className="table-footer"><span>Página {offset/20+1}</span><div className="heading-actions"><Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Anterior</Button><Button variant="outline" disabled={(query.data?.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>Siguiente</Button></div></div>
    </Panel>
  </>
}
