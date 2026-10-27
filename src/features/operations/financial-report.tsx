import { DollarSign } from 'lucide-react'
import { Area,AreaChart,Bar,BarChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis } from 'recharts'
import { Metric,Panel,SectionTitle } from '../../components/common'
import {money} from '../../lib/utils'
import type {Report} from '../../../shared/operations'
export function FinancialMetrics({report}:{report:Report}) {
 const data=report.financial
 if(!data)return null
 const entries:[string,string|null][]=[['Ventas netas',report.net_sales],['Dinero recibido',report.collections],['Cuentas por cobrar',report.outstanding],['Costo de productos vendidos',data.cogs],['Utilidad bruta',report.gross_profit],['Gastos operativos',report.expenses],['Utilidad neta estimada',data.net_profit],['Efectivo en caja',data.cash_on_hand],['Transferencias recibidas',data.transfers_received],['Valor del inventario',data.inventory_value]]
 return <><div className="metrics-grid">{entries.map(([label,value])=><Metric key={label} label={label} value={value===null?'No disponible':money(Number(value))} icon={DollarSign} change={label==='Efectivo en caja'?'Cajas abiertas · saldo actual':'Datos registrados'} note="COP" trend="neutral" />)}
 <Metric label="Margen bruto" value={data.gross_margin===null?'No disponible':`${Number(data.gross_margin).toLocaleString('es-CO',{maximumFractionDigits:2})} %`} icon={DollarSign} change="Utilidad bruta / ventas netas" note="Sin dividir entre cero" trend="neutral" /></div>
 {data.unknown_inventory_costs>0&&<p className="notice">Hay {data.unknown_inventory_costs} productos con existencias sin costo conocido. No se inventa el valor del inventario.</p>}
 <p className="muted">Dinero recibido: efectivo {money(Number(data.cash_received))} · transferencias {money(Number(data.transfers_received))}. Los créditos pendientes no son dinero recibido. Las cifras del período incluyen devoluciones y reintegros; caja, cartera e inventario muestran el saldo actual.</p></>
}
function Chart({title,data,area=false}:{title:string;data:{name:string;amount:number|null}[];area?:boolean}) {
 return <Panel><SectionTitle title={title}/><div className="area-chart" role="img" aria-label={title}><ResponsiveContainer width="100%" height="100%">{area?<AreaChart data={data}><CartesianGrid stroke="var(--border)"/><XAxis dataKey="name"/><YAxis width={80}/><Tooltip formatter={value=>money(Number(value))}/><Area dataKey="amount" stroke="#258367" fill="#258367" fillOpacity={0.15} isAnimationActive={false}/></AreaChart>:<BarChart data={data}><CartesianGrid stroke="var(--border)"/><XAxis dataKey="name"/><YAxis width={80}/><Tooltip formatter={value=>money(Number(value))}/><Bar dataKey="amount" fill="#258367" isAnimationActive={false}/></BarChart>}</ResponsiveContainer></div></Panel>
}
export function FinancialCharts({report}:{report:Report}) {
 const data=report.financial
 if(!data)return null
 return <div className="charts-grid">
 <Chart title="Ventas por período" data={data.periods.map(row=>({name:row.period,amount:Number(row.sales)}))}/>
 <Chart title="Productos más rentables" data={data.profitable_products.map(row=>({name:row.name,amount:row.profit===null?null:Number(row.profit)}))}/>
 <Chart title="Evolución de ganancias" area data={data.trend.map(row=>({name:row.day,amount:row.net_profit===null?null:Number(row.net_profit)}))}/>
 <Chart title="Evolución de cuentas por cobrar" area data={data.trend.map(row=>({name:row.day,amount:Number(row.receivable)}))}/>
 <Chart title="Gastos por período" data={data.periods.map(row=>({name:row.period,amount:Number(row.expenses)}))}/>
 <Chart title="Ingresos por método de pago" data={report.methods.map(row=>({name:row.name,amount:Number(row.total)}))}/>
 </div>
}
