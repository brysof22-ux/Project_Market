import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Panel, SectionTitle } from './common'
import { money } from '../lib/utils'

const tooltip = { background: 'var(--surface)', borderColor: 'var(--border)', borderRadius: 10, fontSize: 12 }
export function SalesChart({ data = [] }: { data?: { day: string; actual: number; previous: number }[] }) {
  return <Panel className="sales-chart"><SectionTitle title="Resumen de ventas" subtitle="Período actual y período anterior equivalente" />
    <div className="area-chart" role="img" aria-label="Gráfica de ventas registradas por día"><ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 15, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 10 }} />
        <YAxis width={70} tickFormatter={(value) => Number(value).toLocaleString('es-CO')} tick={{ fill: 'var(--muted)', fontSize: 10 }} />
        <Tooltip contentStyle={tooltip} formatter={(value, name) => [money(Number(value)), name === 'actual' ? 'Actual' : 'Anterior']} />
        <Area dataKey="previous" stroke="#b4c8bc" strokeDasharray="5 5" fill="transparent" isAnimationActive={false} />
        <Area dataKey="actual" stroke="#258367" fill="#258367" fillOpacity={0.12} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer></div>
  </Panel>
}
export function CategoryChart({ data = [] }: { data?: { category: string; total: string }[] }) {
  return <Panel className="category-chart"><SectionTitle title="Ventas por categoría" subtitle="Ventas netas y devoluciones del período" />
    <div className="area-chart" role="img" aria-label="Ventas netas por categoría"><ResponsiveContainer width="100%" height="100%">
      <BarChart data={data.map((row) => ({ name: row.category, amount: Number(row.total) }))} margin={{ top: 15, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="name" tick={{ fill: 'var(--muted)', fontSize: 10 }} />
        <YAxis width={70} tick={{ fill: 'var(--muted)', fontSize: 10 }} /><Tooltip contentStyle={tooltip} formatter={(value) => money(Number(value))} />
        <Bar dataKey="amount" fill="#258367" isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer></div>
    {!data.length && <p className="empty-state">Sin ventas por categoría en este período.</p>}
  </Panel>
}
