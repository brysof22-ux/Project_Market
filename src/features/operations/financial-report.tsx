import { DollarSign, Banknote, Wallet, TrendingUp, Package, Percent, ArrowDownLeft, Receipt, Landmark, ShoppingBag, ChevronDown } from 'lucide-react'
import { Area,AreaChart,Bar,BarChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis } from 'recharts'
import { Metric,Panel,SectionTitle } from '../../components/common'
import {money} from '../../lib/utils'
import type {Report} from '../../../shared/operations'
function metricExplanation(label:string,value:string|null) {
 const unavailable=value===null
 if(unavailable)return 'Este indicador no se puede calcular con los datos registrados.'
 const descriptions:Record<string,string>={
 'Ventas netas':`Has vendido ${money(Number(value))} en este período, descontando devoluciones.`,
 'Dinero recibido':'Es el dinero realmente recibido por ventas y abonos durante este período, menos reintegros.',
 'Cuentas por cobrar':'Es el dinero que tus clientes todavía deben pagar. Saldo actual.',
 'Costo de productos vendidos':'Es lo que te costaron los productos que ya vendiste.',
 'Utilidad bruta':'Es lo que queda de las ventas después de descontar el costo de los productos.',
 'Gastos operativos':'Son los gastos registrados para mantener funcionando tu negocio.',
 'Utilidad neta estimada':Number(value)<0?'En este período, tus costos y gastos superaron los ingresos de tus ventas.':'Es tu ganancia estimada después de descontar los costos y gastos registrados.',
 'Efectivo en caja':'Es el efectivo registrado actualmente en las cajas abiertas.',
 'Transferencias recibidas':'Es el dinero recibido mediante transferencias durante este período, menos reintegros.',
 'Valor del inventario':'Es el costo estimado de los productos que tienes disponibles.',
 'Margen bruto':`Por cada $100 vendidos, ${Number(value)<0?'el costo supera las ventas en':'te quedan'} ${money(Math.abs(Number(value)))} antes de gastos operativos. No es la ganancia final.`}
 return descriptions[label]??'Datos registrados durante el período seleccionado.'
}
export function FinancialMetrics({report}:{report:Report}) {
 const data=report.financial
 if(!data)return null
 const entries:[string,string|null][]=[['Ventas netas',report.net_sales],['Dinero recibido',report.collections],['Cuentas por cobrar',report.outstanding],['Utilidad neta estimada',data.net_profit],['Utilidad bruta',report.gross_profit],['Costo de productos vendidos',data.cogs],['Gastos operativos',report.expenses],['Efectivo en caja',data.cash_on_hand],['Transferencias recibidas',data.transfers_received],['Valor del inventario',data.inventory_value]]
 const icons=[DollarSign,Banknote,Wallet,TrendingUp,TrendingUp,ShoppingBag,Receipt,Landmark,ArrowDownLeft,Package]
 const renderMetric=([label,value]:[string,string|null],index:number)=><Metric key={label} label={label} value={value===null?'No disponible':money(Number(value))} description={metricExplanation(label,value)} icon={icons[index]} change={label==='Efectivo en caja'?'Cajas abiertas':label==='Cuentas por cobrar'||label==='Valor del inventario'?'Saldo actual':value===null?'Costo sin registrar':'En el período seleccionado'} trend={value!==null&&Number(value)<0?'down':'neutral'} />
 return <><p className="report-context">Resultados del período <span>Valores en pesos colombianos · COP</span></p><div className="metrics-grid financial-overview">{entries.slice(0,4).map(renderMetric)}</div><div className="metrics-grid financial-details">{entries.slice(4).map((entry,index)=>renderMetric(entry,index+4))}
 <Metric label="Margen bruto" description={metricExplanation('Margen bruto',data.gross_margin)} value={data.gross_margin===null?'No disponible':`${Number(data.gross_margin).toLocaleString('es-CO',{maximumFractionDigits:2})} %`} icon={Percent} change="Antes de gastos operativos" trend="neutral" /></div>
 {data.unknown_inventory_costs>0&&<p className="notice">Hay {data.unknown_inventory_costs} productos con existencias sin costo conocido. No se inventa el valor del inventario.</p>}
 <p className="muted">Dinero recibido: efectivo {money(Number(data.cash_received))} · transferencias {money(Number(data.transfers_received))}. Los créditos pendientes no son dinero recibido. Las cifras del período incluyen devoluciones y reintegros; caja, cartera e inventario muestran el saldo actual.</p></>
}
function Chart({title,data,area=false}:{title:string;data:{name:string;amount:number|null}[];area?:boolean}) {
 return <Panel><SectionTitle title={title}/><div className="area-chart" role="img" aria-label={title}><ResponsiveContainer width="100%" height="100%">{area?<AreaChart data={data}><CartesianGrid stroke="var(--border)"/><XAxis dataKey="name"/><YAxis width={80}/><Tooltip formatter={value=>money(Number(value))}/><Area dataKey="amount" stroke="#258367" fill="#258367" fillOpacity={0.15} isAnimationActive={false}/></AreaChart>:<BarChart data={data}><CartesianGrid stroke="var(--border)"/><XAxis dataKey="name"/><YAxis width={80}/><Tooltip formatter={value=>money(Number(value))}/><Bar dataKey="amount" fill="#258367" isAnimationActive={false}/></BarChart>}</ResponsiveContainer></div></Panel>
}
export function FinancialCharts({report}:{report:Report}) {
 const data=report.financial
 if(!data)return null
 return <details className="financial-chart-details"><summary><span><strong>Análisis financiero detallado</strong><small>Rentabilidad, gastos, cartera y métodos de pago</small></span><ChevronDown size={18}/></summary><div className="charts-grid">
 <Chart title="Ventas por período" data={data.periods.map(row=>({name:row.period,amount:Number(row.sales)}))}/>
 <Chart title="Productos más rentables" data={data.profitable_products.map(row=>({name:row.name,amount:row.profit===null?null:Number(row.profit)}))}/>
 <Chart title="Evolución de ganancias" area data={data.trend.map(row=>({name:row.day,amount:row.net_profit===null?null:Number(row.net_profit)}))}/>
 <Chart title="Evolución de cuentas por cobrar" area data={data.trend.map(row=>({name:row.day,amount:Number(row.receivable)}))}/>
 <Chart title="Gastos por período" data={data.periods.map(row=>({name:row.period,amount:Number(row.expenses)}))}/>
 <Chart title="Ingresos por método de pago" data={report.methods.map(row=>({name:row.name,amount:Number(row.total)}))}/>
 </div></details>
}
