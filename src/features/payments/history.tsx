import { Banknote, Landmark, ReceiptText } from 'lucide-react'
import { Badge, EmptyState, Panel, SectionTitle } from '../../components/common'
import { summarizeDemoPayments } from './repository'
import { usePayments } from './use-payments'
import { formatPaymentMoney } from './types'

export function PaymentHistory() {
  const { sales, error } = usePayments()
  const totals = summarizeDemoPayments(sales)
  return (
    <Panel className="payment-history">
      <SectionTitle
        title="Historial de pagos · Demo local"
        subtitle="Ventas finalizadas en este navegador. No incluye datos reales ni las ventas registradas en el servidor."
        action={<Badge tone="neutral">Sin conexión bancaria</Badge>}
      />
      <div className="payment-summary">
        <div>
          <Banknote size={17} />
          <span>
            Efectivo físico simulado
            <strong>{formatPaymentMoney(totals.cash)}</strong>
          </span>
        </div>
        <div>
          <Landmark size={17} />
          <span>
            Transferencias simuladas
            <strong>{formatPaymentMoney(totals.transfer)}</strong>
          </span>
        </div>
        <div>
          <ReceiptText size={17} />
          <span>
            Tarjeta simulada<strong>{formatPaymentMoney(totals.card)}</strong>
          </span>
        </div>
      </div>
      {error && (
        <p className="payment-error" role="alert">
          {error}
        </p>
      )}
      {!sales.length ? (
        <EmptyState text="Aún no hay pagos locales. Finaliza una venta simulada para registrar su historial." />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>VENTA / FECHA</th>
                <th>MÉTODO</th>
                <th>IMPORTE</th>
                <th>REFERENCIA</th>
                <th>RESPONSABLE / CONFIRMACIÓN</th>
                <th>ESTADO</th>
              </tr>
            </thead>
            <tbody>
              {sales.flatMap((sale) =>
                sale.payments.map((payment, index) => (
                  <tr key={`${sale.id}:${index}`}>
                    <td>
                      <strong>#{sale.id.slice(0, 8)}</strong>
                      <small className="payment-history-date">
                        {new Date(sale.confirmedAt).toLocaleString('es-CO')}
                      </small>
                    </td>
                    <td>
                      {payment.kind === 'transfer'
                        ? payment.transfer?.methodName
                        : payment.kind === 'cash'
                          ? 'Efectivo'
                          : 'Tarjeta'}
                      {payment.transfer && (
                        <small className="payment-history-date">
                          {payment.transfer.institution} · QR v
                          {payment.transfer.revision}
                        </small>
                      )}
                    </td>
                    <td className="amount">
                      {formatPaymentMoney(payment.amountMinor)}
                    </td>
                    <td>{payment.transfer?.reference ?? '—'}</td>
                    <td>
                      {payment.transfer?.confirmedBy.name ?? sale.actor.name}
                      <small className="payment-history-date">
                        {new Date(
                          payment.transfer?.confirmedAt ?? sale.confirmedAt,
                        ).toLocaleString('es-CO')}
                      </small>
                    </td>
                    <td>
                      <Badge tone="neutral">
                        {payment.kind === 'transfer'
                          ? 'Manual · Demo'
                          : 'Simulado'}
                      </Badge>
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine-print">
        Las transferencias y las tarjetas no aumentan el efectivo físico. Este
        resumen local no es un arqueo ni un reporte contable real.
      </p>
    </Panel>
  )
}
