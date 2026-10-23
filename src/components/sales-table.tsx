import { useState } from 'react'
import { ArrowRight, ArrowUpRight, CreditCard, Wallet } from 'lucide-react'
import { Badge, EmptyState, Panel, SectionTitle } from './common'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'
import { sales, type Sale } from '../data/mock'
import { money } from '../lib/utils'

export function SalesTable({ full = false }: { full?: boolean }) {
  const [filter, setFilter] = useState('Todas')
  const [selected, setSelected] = useState<Sale | null>(null)
  const filtered = sales.filter(
    (sale) => filter === 'Todas' || sale.status === filter,
  )
  return (
    <Panel className="sales-table-panel">
      <SectionTitle
        title="Ventas recientes"
        subtitle="Un vistazo a tus últimas transacciones"
        action={
          full ? (
            <select
              aria-label="Estado de venta"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option>Todas</option>
              <option>Completada</option>
              <option>Pendiente</option>
            </select>
          ) : (
            <Button asChild variant="ghost" size="sm">
              <a href="#/contabilidad">
                Ver todas <ArrowRight size={14} />
              </a>
            </Button>
          )
        }
      />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>VENTA / CLIENTE</th>
              <th>HORA</th>
              <th>PRODUCTOS</th>
              <th>MÉTODO DE PAGO</th>
              <th>TOTAL</th>
              <th>ESTADO</th>
              <th>
                <span className="sr-only">Detalle</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((sale) => (
              <tr key={sale.id}>
                <td>
                  <div className="person-cell">
                    <span className={`avatar ${sale.color}`}>
                      {sale.initials}
                    </span>
                    <span>
                      <strong>{sale.name}</strong>
                      <small>#{sale.id}</small>
                    </span>
                  </div>
                </td>
                <td className="muted">{sale.time}</td>
                <td className="muted">{sale.items} productos</td>
                <td>
                  <span className="payment">
                    {sale.method === 'Tarjeta' ? (
                      <CreditCard size={14} />
                    ) : (
                      <Wallet size={14} />
                    )}
                    {sale.method}
                  </span>
                </td>
                <td className="amount">{money(sale.total)}</td>
                <td>
                  <Badge tone={sale.status === 'Pendiente' ? 'amber' : 'green'}>
                    <i />
                    {sale.status}
                  </Badge>
                </td>
                <td>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Ver venta ${sale.id}`}
                    onClick={() => setSelected(sale)}
                  >
                    <ArrowUpRight size={17} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <EmptyState />}
      </div>
      <div className="table-footer">
        <span>
          Mostrando {filtered.length} de {sales.length} ventas de ejemplo
        </span>
        <span>
          <span className="live-dot" /> Datos simulados
        </span>
      </div>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        title={`Venta #${selected?.id ?? ''}`}
        description="Detalle de una transacción ficticia. No es un comprobante fiscal."
      >
        {selected && (
          <dl className="detail-list">
            <div>
              <dt>Cliente</dt>
              <dd>{selected.name}</dd>
            </div>
            <div>
              <dt>Fecha</dt>
              <dd>23 de octubre de 2026 · {selected.time}</dd>
            </div>
            <div>
              <dt>Productos</dt>
              <dd>{selected.items}</dd>
            </div>
            <div>
              <dt>Método</dt>
              <dd>{selected.method}</dd>
            </div>
            <div>
              <dt>Estado</dt>
              <dd>{selected.status}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{money(selected.total)}</dd>
            </div>
          </dl>
        )}
      </Dialog>
    </Panel>
  )
}
