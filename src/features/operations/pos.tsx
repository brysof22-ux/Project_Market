import { useState, useCallback, type FormEvent } from 'react'
import { EmptyState, PageHeading, Panel, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { QueryState, Pagination } from '../catalog/common'
import { useCatalogQuery, useOperationsMutation, useOperationsQuery, useSearch } from '../catalog/hooks'
import { TransferPicker } from '../payments/transfer-qr'
import type { TransferQR } from '../../../shared/catalog'
import { SalesHistory } from './sales'
import { OwnCash } from './own-cash'
import { ProductImage } from '../catalog/product-image'
import type { Contact } from '../../../shared/catalog'
import { money } from '../../lib/utils'
import { parseMinor } from '../payments/types'
import type { Product, ProductPage } from '../../../shared/catalog'
import type { Bootstrap } from '../../../shared/operations'

export function PointOfSale() {
  const [transfer, setTransfer] = useState(false)
  const [qr, setQR] = useState<TransferQR | null>(null)
  const [qrReady, setQRReady] = useState(false)
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [cart, setCart] = useState<Record<string, { product: Product; quantity: number }>>({})
  const [financed, setFinanced] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const selectQR = useCallback((method: TransferQR | null) => { setQR(method); setConfirmed(false) }, [])
  const readyQR = useCallback((ready: boolean) => { setQRReady(ready); if (!ready) setConfirmed(false) }, [])
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
    const methods = (bootstrap.data?.methods ?? []).filter((method) => method.code !== 'card')
    const entered = methods.map((method) => ({ method_id: method.id, amount: String(values.get(`amount-${method.id}`) || '0'), ...(method.code === 'transfer' ? { qr_code: qr?.code, qr_image_id: qr?.image_id, manually_verified: confirmed } : {}) }))
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
    if (payments.some((payment) => methods.find((method) => method.id === payment.method_id)?.code === 'transfer') && (!qrReady || !qr?.image_id)) { setValidation('Carga y revisa el QR antes de confirmar la transferencia.'); return }
    if (await mutation.run('sale.confirm', {
      session_id: bootstrap.data?.session?.id, customer_id: values.get('customer_id') || null,
      buyer_name: values.get('buyer_name') || null,
      customer_name: financed ? values.get('customer_name') : null,
      customer_phone: financed ? values.get('customer_phone') : null,
      due_on: financed ? values.get('due_on') || null : null,
      expected_total: (totalMinor / 100).toFixed(2),
      finance: financed, lines: lines.map(({ product, quantity }) => ({ product_id: product.id, quantity })), payments,
    })) {
      setCart({}); setTransfer(false); setFinanced(false); setConfirmed(false); setNotice('Venta registrada en la tienda.'); setRevision((value) => value + 1)
    }
  }
  return <>
    <PageHeading title="Punto de venta" subtitle="Las ventas confirmadas registran pagos y descuentan existencias de forma transaccional." />
    {notice && <p role="status">{notice}</p>}
    <QueryState {...bootstrap} retry={bootstrap.refresh} />
    {bootstrap.data && <OwnCash session={bootstrap.data.session} onChanged={() => setRevision((value) => value + 1)} />}
    <div className="pos-grid">
      <Panel><SectionTitle title="Productos" /><label className="search-field"><input aria-label="Buscar productos para venta" value={search} maxLength={100} onChange={(event) => { setSearch(event.target.value); setOffset(0) }} placeholder="Buscar producto por nombre" /></label>
        <QueryState {...query} retry={query.refresh} />
        <div className="product-grid">{query.data?.rows.filter((row) => row.active).map((product) => <Button key={product.id} variant="outline"
          className="pos-product-card" aria-label={`Agregar ${product.name}`} disabled={mutation.busy || product.stock <= (cart[product.id]?.quantity ?? 0)} onClick={() => change(product, 1)}>
          <ProductImage product={product} /><strong>{product.name}</strong><span className="pos-product-price">{money(Number(product.price))}</span><span>{product.stock} disponibles</span></Button>)}</div>
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
          <fieldset disabled={mutation.busy} className="business-fieldset">
            <label className="checkbox-label"><input type="checkbox" checked={financed} onChange={(event) => setFinanced(event.target.checked)} />Vender a crédito</label>
            {financed ? <CreditBuyer /> : <label className="form-label">Nombre del comprador (opcional)<input name="buyer_name" maxLength={160} placeholder="Consumidor final" /></label>}
            {bootstrap.data?.methods.filter((method) => method.code !== 'card').map((method) => <div key={method.id}>
              <label className="form-label">Pago {method.name}<input name={`amount-${method.id}`} type="number" step="0.01" min="0" max="1000000000000" placeholder="0" onChange={(event) => { if (method.code === 'transfer') setTransfer(Number(event.target.value) > 0) }} /></label>
            </div>)}
            {transfer && <TransferPicker onSelect={selectQR} onReady={readyQR} />}
            {financed && <p className="muted">Los pagos registrados son el abono inicial. El saldo restante se registra como deuda; no necesitas autorizar un cupo.</p>}
            <label className="checkbox-label"><input name="confirm_payments" type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Confirmo los pagos recibidos. Verifiqué manualmente la recepción de las transferencias.</label>
          </fieldset>
          {(validation || mutation.error) && <p role="alert">{validation || mutation.error}</p>}
          <Button type="submit" disabled={(transfer && !qrReady) || !lines.length || !confirmed || mutation.busy || !bootstrap.data?.session}>{mutation.busy ? 'Registrando…' : 'Registrar venta'}</Button>
        </form>
      </Panel>
    </div>
    <SalesHistory revision={revision} onChanged={() => setRevision((value) => value + 1)} />
  </>
}

function CreditBuyer() {
  const [existing, setExisting] = useState(false)
  return <>
    <label className="checkbox-label"><input type="checkbox" checked={existing} onChange={(event) => setExisting(event.target.checked)} />Usar una persona existente</label>
    {existing ? <ExistingDebtor /> : <>
      <label className="form-label">Nombre completo<input name="customer_name" required maxLength={160} pattern=".*\S.*" /></label>
      <label className="form-label">Teléfono<input name="customer_phone" type="tel" required maxLength={30} minLength={7} pattern="[+0-9() .-]{7,30}" /></label>
      <p className="muted">Se crea una identidad nueva. Los nombres o teléfonos coincidentes nunca unen deudas automáticamente.</p>
    </>}
    <label className="form-label">Fecha de vencimiento (opcional)<input name="due_on" type="date" /></label>
  </>
}

function ExistingDebtor() {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const query = useCatalogQuery<{ customers: Pick<Contact, 'id' | 'name' | 'phone' | 'active' | 'version'>[] }>('customers.search', { search: useSearch(search), limit: 100 })
  return <>
    <label className="form-label">Buscar persona existente<input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} placeholder="Nombre o teléfono" /></label>
    <QueryState {...query} retry={query.refresh} />
    <label className="form-label">Persona existente<select name="customer_id" required value={selected} onChange={(event) => setSelected(event.target.value)}>
      <option value="">Selecciona una persona</option>
      {query.data?.customers.filter((row) => row.active).map((row) => <option value={row.id} key={row.id}>{row.name} · {row.phone} · {row.id}</option>)}
    </select></label>
    <p className="muted">Verifica teléfono e identificador: dos personas pueden tener el mismo nombre.</p>
  </>
}
