import { useRef, useState } from 'react'
import { Check, Minus, Plus, Search, ShoppingCart, Trash2 } from 'lucide-react'
import { EmptyState, Panel, SectionTitle } from '../components/common'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { products } from '../data/mock'
import { money } from '../lib/utils'
import { PageHeading } from '../components/common'
import { usePayments } from './payments/use-payments'
import { TransferModal } from './payments/transfer-modal'
import { PaymentHistory } from './payments/history'
import {
  formatPaymentMoney,
  parseMinor,
  type DemoPayment,
  type DemoSale,
  type TransferDraft,
} from './payments/types'

export function PointOfSale() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('Todas')
  const [cart, setCart] = useState<Record<string, number>>({})
  const [payment, setPayment] = useState('Efectivo')
  const [complete, setComplete] = useState(false)
  const {
    actor,
    methods,
    ready,
    error: storageError,
    commitSale,
    refresh,
  } = usePayments()
  const [mixed, setMixed] = useState({ cash: '', transfer: '', card: '' })
  const [transfer, setTransfer] = useState<TransferDraft | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [paymentError, setPaymentError] = useState('')
  const inFlight = useRef(false)
  const operation = useRef(crypto.randomUUID())
  const pendingSale = useRef<DemoSale | null>(null)
  const paymentSelect = useRef<HTMLSelectElement>(null)
  const filtered = products.filter(
    (product) =>
      product.name
        .toLocaleLowerCase('es')
        .includes(search.toLocaleLowerCase('es')) &&
      (category === 'Todas' || product.category === category),
  )
  const items = products.filter((product) => (cart[product.id] ?? 0) > 0)
  const total = items.reduce(
    (sum, product) => sum + product.price * cart[product.id],
    0,
  )
  const totalMinor = total * 100
  const mixedMinor = {
    cash: parseMinor(mixed.cash || '0'),
    transfer: parseMinor(mixed.transfer || '0'),
    card: parseMinor(mixed.card || '0'),
  }
  const mixedValid =
    Object.values(mixedMinor).every((value) => value !== null) &&
    Object.values(mixedMinor).reduce<number>(
      (sum, value) => sum + (value ?? 0),
      0,
    ) === totalMinor &&
    Object.values(mixedMinor).filter((value) => value !== null && value > 0)
      .length >= 2
  const transferMinor =
    payment === 'Transferencia'
      ? totalMinor
      : payment === 'Pago mixto'
        ? (mixedMinor.transfer ?? 0)
        : 0
  const transferMethod = methods.find(
    (method) => method.id === transfer?.methodId,
  )
  const transferValid =
    !!transfer &&
    transfer.amountMinor === transferMinor &&
    transfer.confirmedBy.id === actor.id &&
    transferMethod?.active === true &&
    transferMethod.revision === transfer.revision
  const canComplete =
    !!items.length &&
    ready &&
    !busy &&
    payment !== 'Crédito' &&
    (payment !== 'Pago mixto' || mixedValid) &&
    (transferMinor === 0 || transferValid)
  function invalidate() {
    pendingSale.current = null
    operation.current = crypto.randomUUID()
    setPaymentError('')
  }
  function choosePayment(value: string) {
    setPayment(value)
    setTransfer(null)
    invalidate()
    setTransferOpen(value === 'Transferencia')
  }
  async function finalize() {
    if (!canComplete || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setPaymentError('')
    try {
      const payments: DemoPayment[] = []
      const addPayment = (kind: DemoPayment['kind'], amountMinor: number) => {
        if (amountMinor <= 0) return
        payments.push({
          kind,
          amountMinor,
          ...(kind === 'transfer' && transfer && transferMethod
            ? {
                transfer: {
                  ...transfer,
                  methodName: transferMethod.name,
                  institution: transferMethod.institution,
                  holder: transferMethod.holder,
                  imagePath: transferMethod.imagePath,
                },
              }
            : {}),
        })
      }
      if (payment === 'Pago mixto') {
        addPayment('cash', mixedMinor.cash!)
        addPayment('transfer', mixedMinor.transfer!)
        addPayment('card', mixedMinor.card!)
      } else
        addPayment(
          payment === 'Transferencia'
            ? 'transfer'
            : payment === 'Tarjeta'
              ? 'card'
              : 'cash',
          totalMinor,
        )
      pendingSale.current ??= {
        id: crypto.randomUUID(),
        operationKey: operation.current,
        confirmedAt: new Date().toISOString(),
        actor: { ...actor },
        totalMinor,
        items: items.map((product) => ({
          productId: product.id,
          quantity: cart[product.id],
          unitPriceMinor: product.price * 100,
        })),
        payments,
        mode: 'demo',
      }
      await commitSale(pendingSale.current)
      setComplete(true)
    } catch (cause) {
      setPaymentError(
        cause instanceof Error
          ? cause.message
          : 'No se pudo guardar la venta local.',
      )
      await refresh()
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  function adjust(id: string, delta: number) {
    if (busy || complete) return
    setTransfer(null)
    invalidate()
    setCart((previous) => ({
      ...previous,
      [id]: Math.max(
        0,
        Math.min(
          products.find((product) => product.id === id)!.stock,
          (previous[id] ?? 0) + delta,
        ),
      ),
    }))
  }
  return (
    <>
      <PageHeading
        title="Punto de venta"
        subtitle="Prueba una venta con el catálogo de demostración. No se generan cobros reales."
      />
      <div className="pos-grid">
        <Panel>
          <SectionTitle
            title="Selecciona tus productos"
            subtitle="Los precios están expresados en pesos colombianos"
          />
          <div className="table-toolbar">
            <label className="search-field">
              <Search size={17} />
              <input
                aria-label="Buscar en punto de venta"
                placeholder="Buscar producto…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label="Categoría de venta"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option>Todas</option>
              {[...new Set(products.map((product) => product.category))].map(
                (item) => (
                  <option key={item}>{item}</option>
                ),
              )}
            </select>
          </div>
          <div className="product-grid">
            {filtered.map((product) => (
              <button
                key={product.id}
                className="product-card"
                disabled={(cart[product.id] ?? 0) >= product.stock}
                onClick={() => adjust(product.id, 1)}
                aria-label={`Agregar ${product.name}`}
              >
                <span className={`product-tile ${product.color}`}>
                  {product.emoji}
                  <span className="product-add">
                    <Plus size={16} />
                  </span>
                </span>
                <small>
                  {product.category} · {product.stock} uds.
                </small>
                <strong>{product.name}</strong>
                <b>{money(product.price)}</b>
              </button>
            ))}
          </div>
          {!filtered.length && <EmptyState />}
        </Panel>
        <Panel className="cart-panel">
          <SectionTitle
            title="Venta de prueba"
            action={<ShoppingCart size={19} />}
          />
          <p className="muted mb-5">Consumidor final · Datos simulados</p>
          {!items.length ? (
            <EmptyState text="Agrega productos para comenzar tu venta de prueba." />
          ) : (
            <div className="cart-list">
              {items.map((product) => (
                <div className="cart-item" key={product.id}>
                  <div>
                    <strong>{product.name}</strong>
                    <small>{money(product.price)} / unidad</small>
                  </div>
                  <div className="quantity">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Quitar una unidad de ${product.name}`}
                      onClick={() => adjust(product.id, -1)}
                    >
                      <Minus size={13} />
                    </Button>
                    <span>{cart[product.id]}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Sumar una unidad de ${product.name}`}
                      disabled={cart[product.id] >= product.stock}
                      onClick={() => adjust(product.id, 1)}
                    >
                      <Plus size={13} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="cart-total">
            <span>Total simulado</span>
            <strong>{money(total)}</strong>
          </div>
          <label className="form-label">
            Método de pago de ejemplo
            <select
              ref={paymentSelect}
              value={payment}
              onChange={(e) => choosePayment(e.target.value)}
              disabled={busy || complete || !ready}
            >
              <option>Efectivo</option>
              <option>Transferencia</option>
              <option>Tarjeta</option>
              <option>Crédito</option>
              <option>Pago mixto</option>
            </select>
          </label>
          {payment === 'Crédito' && (
            <div className="notice mt-3">
              Crédito está pendiente de conexión al módulo de cartera. No se
              puede registrar una venta a crédito desde esta demostración.
            </div>
          )}
          {payment === 'Pago mixto' && (
            <div className="mixed-payment-fields">
              <p>Distribuye el total entre al menos dos métodos.</p>
              {(
                [
                  ['cash', 'Efectivo'],
                  ['transfer', 'Transferencia'],
                  ['card', 'Tarjeta'],
                ] as const
              ).map(([key, label]) => (
                <label className="form-label" key={key}>
                  {label} en pago mixto
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0,00"
                    value={mixed[key]}
                    disabled={busy || complete}
                    onChange={(event) => {
                      setMixed((previous) => ({
                        ...previous,
                        [key]: event.target.value,
                      }))
                      if (key === 'transfer') setTransfer(null)
                      invalidate()
                    }}
                  />
                </label>
              ))}
              <p className={mixedValid ? 'payment-matched' : 'muted'}>
                {mixedValid
                  ? 'La suma coincide con el total.'
                  : 'Los importes deben sumar exactamente ' +
                    formatPaymentMoney(totalMinor) +
                    '.'}
              </p>
            </div>
          )}
          {transferMinor > 0 && (
            <div className="transfer-status">
              <p>
                {transferValid
                  ? 'Confirmación manual de prueba registrada. Pendiente de finalizar la venta.'
                  : 'Revisa el QR y confirma manualmente la transferencia de prueba.'}
              </p>
              {transferValid && (
                <small>
                  {transferMethod?.name} · Referencia: {transfer?.reference}
                </small>
              )}
              <Button
                variant="outline"
                className="w-full mt-3"
                disabled={busy || complete}
                onClick={() => setTransferOpen(true)}
              >
                {transferValid
                  ? 'Revisar transferencia'
                  : 'Ver QR y confirmar transferencia'}
              </Button>
            </div>
          )}
          {(paymentError || storageError) && (
            <p role="alert" className="payment-error">
              {paymentError || storageError}
            </p>
          )}
          <Button
            className="w-full mt-5"
            disabled={!canComplete || complete}
            onClick={() => {
              void finalize()
            }}
          >
            <Check size={17} />
            {busy ? 'Guardando demostración…' : 'Simular venta'}
          </Button>
          <Button
            className="w-full mt-2"
            variant="ghost"
            disabled={!items.length || busy || complete}
            onClick={() => {
              setCart({})
              setTransfer(null)
              invalidate()
            }}
          >
            <Trash2 size={15} />
            Vaciar carrito
          </Button>
          <p className="fine-print">
            La venta se guarda únicamente en el historial local de demostración.
            No modifica el inventario, no emite facturas ni verifica un banco.
          </p>
        </Panel>
      </div>
      <PaymentHistory />
      {transferOpen && (
        <TransferModal
          key={transferMinor}
          open
          onOpenChange={setTransferOpen}
          amountMinor={transferMinor}
          returnFocusRef={paymentSelect}
          onConfirm={(draft) => {
            setTransfer(draft)
            pendingSale.current = null
            setPaymentError('')
          }}
        />
      )}
      <Dialog
        open={complete}
        returnFocusRef={paymentSelect}
        onOpenChange={setComplete}
        title="Simulación completada"
        description="No se ha realizado ningún cobro ni verificación bancaria. Solo se guardó una venta de ejemplo en el historial local de este navegador."
      >
        <dl className="detail-list">
          <div>
            <dt>Total de prueba</dt>
            <dd>{money(total)}</dd>
          </div>
          <div>
            <dt>Método seleccionado</dt>
            <dd>{payment}</dd>
          </div>
        </dl>
        <Button
          className="w-full mt-6"
          onClick={() => {
            setComplete(false)
            setCart({})
            setTransfer(null)
            setMixed({ cash: '', transfer: '', card: '' })
            setPayment('Efectivo')
            invalidate()
          }}
        >
          Iniciar otra simulación
        </Button>
      </Dialog>
    </>
  )
}
