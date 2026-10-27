import type { ReactNode } from 'react'
import { ArrowDownLeft, ArrowUpRight, type LucideIcon } from 'lucide-react'
import {MetricTooltip} from './metric-tooltip'
import { cn } from '../lib/utils'

export function Panel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <section className={cn('panel', className)}>{children}</section>
}
export function Badge({
  children,
  tone = 'green',
}: {
  children: ReactNode
  tone?: 'green' | 'amber' | 'neutral'
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}
export function SectionTitle({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
export function Metric({
  label,
  value,
  change,
  icon: Icon,
  trend = 'up',
  note = 'vs. ayer',
  description,
}: {
  label: string
  value: string
  change: string
  icon: LucideIcon
  trend?: 'up' | 'down' | 'neutral'
  note?: string
  description?: string
}) {
  const content = (
    <Panel className="metric">
      <div className="metric-top">
        <span>{label}</span>
        <span className="metric-icon">
          <Icon size={18} />
        </span>
      </div>
      <strong>{value}</strong>
      <div className="metric-bottom">
        <span className={`trend ${trend === 'neutral' ? 'trend-neutral' : ''}`}>
          {trend === 'up' ? (
            <ArrowUpRight size={14} />
          ) : trend === 'down' ? (
            <ArrowDownLeft size={14} />
          ) : null}
          {change}
        </span>
        <span>{note}</span>
      </div>
    </Panel>
  )
  return description ? <MetricTooltip title={label} description={description} value={value} state={trend==='down'?'negative':trend==='up'?'positive':'neutral'}>{content}</MetricTooltip> : content
}
export function EmptyState({
  text = 'No hay resultados para esta búsqueda.',
}: {
  text?: string
}) {
  return <p className="empty-state">{text}</p>
}

export function PageHeading({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children?: ReactNode
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  )
}
