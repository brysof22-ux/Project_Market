import {useEffect,useState} from 'react'
import {Panel,SectionTitle,EmptyState,Badge} from '../../components/common'
import {Button} from '../../components/ui/button'
import {Dialog} from '../../components/ui/dialog'
import {useOperationsQuery,useSearch} from '../catalog/hooks'
import {QueryState,Pagination} from '../catalog/common'
import {SaleDetail} from './sales'
import {money} from '../../lib/utils'
import {businessTime,paymentLabel} from '../../lib/business-format'
import type {TodaySales} from '../../../shared/operations'
export function TodaySalesHistory(){
 const [search,setSearch]=useState(''),[method,setMethod]=useState('all'),[status,setStatus]=useState('all'),[offset,setOffset]=useState(0),[selected,setSelected]=useState<string|null>(null)
 const settled=useSearch(search);const query=useOperationsQuery<TodaySales>('sales.today',{search:settled,method,status,offset,limit:20})
 const {refresh:refreshQuery}=query
 useEffect(()=>{const refresh=()=>{if(!document.hidden)refreshQuery()};window.addEventListener('focus',refresh);const timer=window.setInterval(refresh,60000);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh)}},[refreshQuery])
 const reset=(change:()=>void)=>{change();setOffset(0)}
 return <Panel><SectionTitle title="Ventas de hoy" subtitle={query.data?`Día comercial ${query.data.day} · America/Bogota. Resumen de todo el día; los filtros afectan la tabla.`:'Día comercial determinado por el servidor en Bogotá.'} action={<Button variant="outline" onClick={query.refresh}>Actualizar ventas de hoy</Button>}/>
 {query.data&&<dl className="daily-summary"><div><dt>Ventas realizadas hoy</dt><dd>{query.data.summary.transactions}</dd></div><div><dt>Total vendido hoy</dt><dd>{money(Number(query.data.summary.net_sales))}</dd></div><div><dt>Dinero recibido hoy</dt><dd>{money(Number(query.data.summary.received))}</dd></div><div><dt>Ventas a crédito hoy</dt><dd>{money(Number(query.data.summary.credit))}</dd></div></dl>}
 <div className="table-toolbar"><label className="form-label">Buscar venta o cliente<input type="search" value={search} onChange={e=>reset(()=>setSearch(e.target.value))}/></label><label className="form-label">Pago de la venta<select value={method} onChange={e=>reset(()=>setMethod(e.target.value))}><option value="all">Todos los métodos</option>{['cash','transfer','credit'].map(m=><option key={m} value={m}>{paymentLabel(m)}</option>)}</select></label><label className="form-label">Estado de la venta<select value={status} onChange={e=>reset(()=>setStatus(e.target.value))}><option value="all">Todos los estados</option><option value="completed">Completada</option><option value="pending">Pendiente</option><option value="returned">Devuelta</option></select></label></div>
 <QueryState {...query} retry={query.refresh}/>{query.data&&<><div className="table-scroll"><table><caption className="sr-only">Ventas del día comercial actual</caption><thead><tr>{['Hora','Venta','Cliente','Productos','Total','Pago','Estado','Detalle'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{query.data.rows.map(r=><tr key={r.id}><td>{businessTime(r.created_at)}</td><td>V-{r.number}</td><td>{r.customer}</td><td>{r.products} unidades</td><td>{money(Number(r.total))}</td><td>{r.methods.map(paymentLabel).join(' + ')}</td><td><Badge tone={r.status==='pending'?'amber':r.status==='returned'?'neutral':'green'}>{{pending:'Pendiente',completed:'Completada',returned:'Devuelta'}[r.status]??r.status}</Badge></td><td><Button variant="ghost" onClick={()=>setSelected(r.id)}>Ver venta V-{r.number}</Button></td></tr>)}</tbody></table></div>{!query.data.rows.length&&<EmptyState text="No hay ventas con estos filtros hoy."/>}<Pagination offset={offset} total={query.data.total} onChange={setOffset}/></>}
 <p className="muted">El dinero recibido incluye abonos de créditos anteriores y descuenta reintegros. El crédito muestra lo financiado hoy, descontando devoluciones de esas ventas.</p>
 {selected&&<Dialog open onOpenChange={v=>{if(!v)setSelected(null)}} title="Detalle de venta" description="Productos, pagos y crédito del registro original."><SaleDetail id={selected} returned={()=>{setSelected(null);query.refresh()}}/></Dialog>}
 </Panel>
}
