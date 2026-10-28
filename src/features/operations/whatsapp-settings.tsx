import { useState } from 'react'
import {Badge,EmptyState,Panel,SectionTitle} from '../../components/common'
import {Button} from '../../components/ui/button'
import {QueryState} from '../catalog/common'
import {useOperationsMutation,useOperationsQuery} from '../catalog/hooks'
import type {WhatsAppStatus} from '../../../shared/operations'
export function WhatsAppSettings() {
 const query=useOperationsQuery<WhatsAppStatus>('whatsapp.status',{})
 const mutation=useOperationsMutation()
 const [notice,setNotice]=useState('')
 const run=async(action:'whatsapp.settings'|'whatsapp.contact'|'whatsapp.test'|'whatsapp.retry',data:Record<string,unknown>)=>{
  if(await mutation.run(action,data)){setNotice('Configuración o solicitud guardada.');query.refresh()}
 }
 const data=query.data
 return <Panel><SectionTitle title="Conexión y notificaciones" subtitle="Notificaciones con consentimiento; las ventas continúan si el servicio está desconectado." action={<Button variant="outline" onClick={query.refresh}>Comprobar conexión de WhatsApp</Button>}/>
 <QueryState {...query} retry={query.refresh}/>
 {notice&&<p role="status">{notice}</p>}{mutation.error&&<p role="alert">{mutation.error}</p>}
 {data&&<>
  <div className="whatsapp-connection"><div><h3>Estado de conexión</h3><p className="muted">Evolution API</p></div><Badge tone={data.settings.connection_state==='open'?'green':'neutral'}>{({open:'Conectado',close:'Desconectado',connecting:'Conectando',unconfigured:'Sin configurar',unavailable:'No disponible'})[data.settings.connection_state]??'No verificado'}</Badge></div>
  <dl className="settings-meta whatsapp-status-details"><div><dt>Número conectado</dt><dd>{data.settings.connected_number??'No informado por el proveedor'}</dd></div><div><dt>Última conexión verificada</dt><dd>{data.settings.last_connection?new Date(data.settings.last_connection).toLocaleString('es-CO'):'No verificada'}</dd></div><div><dt>Último envío aceptado</dt><dd>{data.settings.last_success?new Date(data.settings.last_success).toLocaleString('es-CO'):'Sin envíos'}</dd></div></dl>
  {data.settings.last_error&&<p role="status">Último error: {data.settings.last_error}</p>}
  <dl className="whatsapp-counts"><div><dt>Pendientes</dt><dd>{data.counts.pending}</dd></div><div><dt>Aceptadas por Evolution</dt><dd>{data.counts.sent}</dd></div><div><dt>Fallidas o inciertas</dt><dd>{data.counts.failed}</dd></div></dl>
  <p className="muted">Aceptar el envío en Evolution no confirma entrega ni lectura. Un resultado incierto no se reintenta automáticamente.</p>
  <form key={JSON.stringify(data.settings)} className="settings-form" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void run('whatsapp.settings',{version:data.settings.version,enabled:values.has('enabled'),purchases:values.has('purchases'),receipts:values.has('receipts'),reminders:values.has('reminders'),days_before:Number(values.get('days_before'))})}}>
   <fieldset disabled={mutation.busy} className="business-fieldset">
    <h3>Preferencias de notificación</h3>
    <label className="checkbox-label"><input name="enabled" type="checkbox" defaultChecked={data.settings.enabled} disabled={data.settings.connection_state!=='open'&&!data.settings.enabled}/>Activar notificaciones de WhatsApp</label>
    <label className="checkbox-label"><input name="purchases" type="checkbox" defaultChecked={data.settings.purchases}/>Confirmaciones de compras a crédito</label>
    <label className="checkbox-label"><input name="receipts" type="checkbox" defaultChecked={data.settings.receipts}/>Confirmaciones de abonos y deuda saldada</label>
    <label className="checkbox-label"><input name="reminders" type="checkbox" defaultChecked={data.settings.reminders}/>Recordatorios de vencimiento</label>
    <label className="form-label">Días antes del vencimiento<input name="days_before" type="number" min="1" max="30" step="1" required defaultValue={data.settings.days_before}/></label>
    <p className="muted">También se recuerda el día de vencimiento. Sin vencimiento, sin consentimiento o con deuda pagada no se generan recordatorios. Se requiere una conexión verificada y al menos un contacto autorizado para activar.</p>
   </fieldset><Button type="submit" disabled={mutation.busy}>Guardar cambios de WhatsApp</Button>
  </form>
  <details className="settings-details"><summary>Consentimiento de clientes</summary><form className="settings-form" onSubmit={event=>{event.preventDefault();const v=new FormData(event.currentTarget);void run('whatsapp.contact',{customer_id:v.get('customer_id'),granted:v.has('granted'),evidence:v.get('evidence')})}}>
   <label className="form-label">Cliente para autorización<select name="customer_id" required><option value="">Selecciona un cliente</option>{data.contacts.map(c=><option key={c.id} value={c.id}>{c.name} · {c.phone} · {c.consented?'Autorizado':'Sin autorización'}</option>)}</select></label>
   <label className="checkbox-label"><input name="granted" type="checkbox"/>El cliente autoriza avisos de compras a crédito, abonos y recordatorios a su número</label>
   <label className="form-label">Evidencia de la autorización o revocación<textarea name="evidence" required minLength={5} maxLength={1000}/></label>
   <Button type="submit" disabled={mutation.busy}>Guardar consentimiento</Button>
  </form></details>
  <details className="settings-details"><summary>Mensaje de prueba autorizado</summary><form className="settings-form" onSubmit={event=>{event.preventDefault();const v=new FormData(event.currentTarget);void run('whatsapp.test',{customer_id:v.get('customer_id'),authorized:v.has('authorized')})}}>
   <label className="form-label">Contacto autorizado para prueba<select name="customer_id" required><option value="">Selecciona un contacto autorizado</option>{data.contacts.filter(c=>c.consented).map(c=><option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}</select></label>
   <label className="checkbox-label"><input name="authorized" type="checkbox" required/>Autorizo este mensaje de prueba al contacto seleccionado</label>
   <Button type="submit" disabled={mutation.busy||!data.settings.enabled||data.settings.connection_state!=='open'}>Solicitar mensaje de prueba</Button>
  </form></details>
  <div className="settings-recent"><h3>Notificaciones recientes</h3><ul className="notification-list">{data.jobs.map(job=><li key={job.id}><div><strong>{job.kind}</strong><small>{new Date(job.created_at).toLocaleString('es-CO')}{job.error_code&&` · ${job.error_code}`}</small></div><Badge tone={job.status==='failed'?'amber':job.status==='sent'?'green':'neutral'}>{job.status}</Badge>{job.status==='failed'&&<Button variant="outline" disabled={mutation.busy} onClick={()=>void run('whatsapp.retry',{job_id:job.id})}>Reintentar mensaje</Button>}</li>)}</ul>{!data.jobs.length&&<EmptyState text="No hay notificaciones recientes."/>}</div>
 </>}
 </Panel>
}
