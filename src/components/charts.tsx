import { useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { categories, monthlySales, weeklySales } from '../data/mock'
import { money } from '../lib/utils'
import { Panel, SectionTitle } from './common'

export function SalesChart() {
  const [period, setPeriod] = useState('week')
  const data = period === 'week' ? weeklySales : monthlySales
  const total = data.reduce((sum, day) => sum + day.actual, 0)
  const previousTotal = data.reduce((sum, day) => sum + day.previous, 0)
  const growth = ((total / previousTotal - 1) * 100).toLocaleString('es-CO', {
    maximumFractionDigits: 1,
  })
  return (
    <Panel className="sales-chart">
      <SectionTitle
        title="Resumen de ventas"
        subtitle="Así se mueve tu negocio"
        action={
          <div className="segmented" aria-label="Período de la gráfica">
            <button
              aria-pressed={period === 'week'}
              className={period === 'week' ? 'selected' : ''}
              onClick={() => setPeriod('week')}
            >
              Esta semana
            </button>
            <button
              aria-pressed={period === 'month'}
              className={period === 'month' ? 'selected' : ''}
              onClick={() => setPeriod('month')}
            >
              Este mes
            </button>
          </div>
        }
      />
      <div className="chart-summary">
        <strong>{money(total)}</strong>
        <span className="badge badge-green">+{growth} %</span>
        <span className="muted">vs. período anterior</span>
      </div>
      <div className="chart-legend">
        <span>
          <i className="legend-dot" />
          Período actual
        </span>
        <span>
          <i className="legend-dot pale" />
          Período anterior
        </span>
      </div>
      <div
        className="area-chart"
        role="img"
        aria-label="Gráfica de ventas simuladas por período"
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={period === 'week' ? weeklySales : monthlySales}
            margin={{ top: 15, right: 10, left: -16, bottom: 0 }}
          >
            <defs>
              <linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2b8a68" stopOpacity={0.17} />
                <stop offset="100%" stopColor="#2b8a68" stopOpacity={0.01} />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              stroke="var(--border)"
              strokeDasharray="3 4"
            />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              dy={10}
            />
            <YAxis
              tickFormatter={(v) => `${v / 1000000} M`}
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'var(--muted)', fontSize: 10 }}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--surface)',
                borderColor: 'var(--border)',
                borderRadius: 10,
                fontSize: 12,
              }}
              formatter={(value, name) => [
                money(Number(value)),
                name === 'actual' ? 'Actual' : 'Anterior',
              ]}
            />
            <Area
              isAnimationActive={false}
              type="monotone"
              dataKey="previous"
              stroke="#b4c8bc"
              strokeWidth={2}
              strokeDasharray="5 5"
              fill="transparent"
            />
            <Area
              isAnimationActive={false}
              type="monotone"
              dataKey="actual"
              stroke="#258367"
              strokeWidth={2.5}
              fill="url(#salesGradient)"
              activeDot={{ r: 5, strokeWidth: 3, stroke: 'var(--surface)' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  )
}
export function CategoryChart() {
  return (
    <Panel className="category-chart">
      <SectionTitle
        title="Ventas por categoría"
        subtitle="Distribución de esta semana"
      />
      <div className="donut-wrapper">
        <div
          className="donut"
          role="img"
          aria-label="Alimentos 42 %, bebidas 28 %, aseo y hogar 18 %, otros 12 %"
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                isAnimationActive={false}
                data={categories}
                dataKey="value"
                innerRadius="73%"
                outerRadius="94%"
                startAngle={90}
                endAngle={-270}
                paddingAngle={3}
                stroke="none"
              >
                {categories.map((category) => (
                  <Cell key={category.name} fill={category.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: 'var(--surface)',
                  borderColor: 'var(--border)',
                  borderRadius: 10,
                }}
                formatter={(value) => `${value} %`}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="donut-center">
          <span>Total de ventas</span>
          <strong>486</strong>
          <small>esta semana</small>
        </div>
      </div>
      <div className="category-legend">
        {categories.map((category) => (
          <div key={category.name}>
            <span>
              <i
                className="legend-dot"
                style={{ background: category.color }}
              />
              {category.name}
            </span>
            <strong>
              {category.value}
              <span> %</span>
            </strong>
          </div>
        ))}
      </div>
    </Panel>
  )
}
