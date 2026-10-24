import { useState, type FormEvent } from 'react'
import { EmptyState, PageHeading, Panel, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { QueryState, Pagination } from '../catalog/common'
import { useCatalogQuery, useOperationsMutation, useOperationsQuery, useSearch } from '../catalog/hooks'
import { ContactPicker } from './forms'
import { SalesHistory } from './sales'
import { money } from '../../lib/utils'
import { parseMinor } from '../payments/types'
import type { Product, ProductPage } from '../../../shared/catalog'
import type { Bootstrap } from '../../../shared/operations'

export function PointOfSale() {
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [cart, setCart] = useState<Record<string, { product: Product; quantity: number }>>({})
  const [financed, setFinanced] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')
  const [validation, setValidation] = useState('')
  const settledSearch = useSearch(search)
  const query = useCatalogQuery<ProductPage>('products.list', { search: settledSearch, offset, limit: 20, revision })
  const bootstrap = useOperationsQuery<Bootstrap>('bootstrap', { revision })
  const mutation = useOperationsMutation()
  const lines = Object.values(cart)
  const totalMinor = lines.reduce((sum, line) => sum + (parseMinor(line.product.price) ?? 0) * line.quantity, 0)
  function change(product: Product, delta: number) {
    setNotice('')
    setConfirmed(false)
    setCart((current) => {
      const quantity = Math.min(product.stock, Math.max(0, (current[product.id]?.quantity ?? 0) + delta))
      const next = { ...current }
      if (!quantity) delete next[product.id]
      else next[product.id] = { product, quantity }
      return next
    })
  }
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setValidation('')
    const values = new FormData(event.currentTarget)
    const methods = bootstrap.data?.methods ?? []
    const entered = methods.map((method) => ({ method_id: method.id, amount: String(values.get(`amount-${method.id}`) || '0'), reference: String(values.get(`reference-${method.id}`) || '') }))
    if (entered.some((payment) => parseMinor(payment.amount) === null)) {
      setValidation('Escribe los pagos como valores positivos con un máximo de dos decimales.')
      return
    }
    const payments = entered.filter((payment) => parseMinor(payment.amount)! > 0)
    const paid = payments.reduce((sum, payment) => sum + (parseMinor(payment.amount) ?? 0), 0)
    if (!Number.isSafeInteger(totalMinor) || !totalMinor || paid > totalMinor || (!financed && paid !== totalMinor)) {
      setValidation('Los pagos deben coincidir con el total, o dejar un saldo autorizado a crédito.')
      return
    }
    if (payments.some((payment) => methods.find((method) => method.id === payment.method_id)?.requires_reference && !payment.reference.trim())) {
      setValidation('Registra la referencia de los pagos no efectivos.')
      return
    }
    if (await mutation.run('sale.confirm', {
      session_id: bootstrap.data?.session?.id, customer_id: values.get('customer_id') || null,
      finance: financed, lines: lines.map(({ product, quantity }) => ({ product_id: product.id, quantity })), payments,
    })) {
      setCart({}); setFinanced(false); setConfirmed(false); setNotice('Venta registrada en la tienda.'); setRevision((value) => value + 1)
    }
  }
  return <>
    <PageHeading title="Punto de venta" subtitle="Las ventas confirmadas registran pagos y descuentan existencias de forma transaccional." />
    {notice && <p role="status">{notice}</p>}
    <QueryState {...bootstrap} retry={bootstrap.refresh} />
    {bootstrap.data && !bootstrap.data.session && <p role="alert" className="notice">Abre tu caja antes de registrar ventas. <a href="#/contabilidad">Ir a caja</a></p>}
    <div className="pos-grid">
      <Panel><SectionTitle title="Productos" /><label className="search-field"><input aria-label="Buscar productos para venta" value={search} maxLength={100} onChange={(event) => { setSearch(event.target.value); setOffset(0) }} placeholder="Nombre, SKU o código de barras" /></label>
        <QueryState {...query} retry={query.refresh} />
        <div className="product-grid">{query.data?.rows.filter((row) => row.active).map((product) => <Button key={product.id} variant="outline"
          aria-label={`Agregar ${product.name}`} disabled={mutation.busy || product.stock <= (cart[product.id]?.quantity ?? 0)} onClick={() => change(product, 1)}>
          {product.name} · {money(Number(product.price))} · {product.stock} uds.</Button>)}</div>
        {query.data && <Pagination offset={offset} total={query.data.total} onChange={setOffset} />}
      </Panel>
      <Panel><SectionTitle title="Venta actual" /><ul>{lines.map(({ product, quantity }) => <li key={product.id}>
        <strong>{product.name}</strong> · {quantity} × {money(Number(product.price))}
        <Button variant="ghost" disabled={mutation.busy} aria-label={`Quitar una unidad de ${product.name}`} onClick={() => change(product, -1)}>−</Button>
      </li>)}</ul>{!lines.length && <EmptyState text="Agrega productos al carrito." />}
        <p className="cart-total">Total: <strong>{money(totalMinor / 100)}</strong></p>
        <form className="settings-form" onSubmit={confirm} key={revision} onChange={(event) => {
          if (!(event.target instanceof Element) || event.target.getAttribute('name') !== 'confirm_payments') setConfirmed(false)
        }}>
          <fieldset disabled={mutation.busy} className="business-fieldset"><ContactPicker required={financed} />
            {bootstrap.data?.methods.map((method) => <div key={method.id}>
              <label className="form-label">Pago {method.name}<input name={`amount-${method.id}`} type="number" step="0.01" min="0" max="1000000000000" placeholder="0" /></label>
              {method.requires_reference && <label className="form-label">Referencia {method.name}<input name={`reference-${method.id}`} maxLength={160} /></label>}
            </div>)}
            {bootstrap.data?.permissions.credit && <label className="checkbox-label"><input type="checkbox" checked={financed} onChange={(event) => setFinanced(event.target.checked)} />Financiar saldo pendiente</label>}
            <label className="checkbox-label"><input name="confirm_payments" type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Confirmo los pagos recibidos. Las transferencias y tarjetas se verifican manualmente.</label>
          </fieldset>
          {(validation || mutation.error) && <p role="alert">{validation || mutation.error}</p>}
          <Button type="submit" disabled={!lines.length || !confirmed || mutation.busy || !bootstrap.data?.session}>{mutation.busy ? 'Registrando…' : 'Registrar venta'}</Button>
        </form>
      </Panel>
    </div>
    <SalesHistory revision={revision} onChanged={() => setRevision((value) => value + 1)} />
  </>
}
