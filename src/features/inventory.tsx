import { useState, type FormEvent } from 'react'
import { Badge, EmptyState, PageHeading, Panel, SectionTitle } from '../components/common'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { money } from '../lib/utils'
import { useAuth } from './auth/context'
import { useCatalogMutation, useCatalogQuery, useSearch } from './catalog/hooks'
import { QueryState, Pagination } from './catalog/common'
import { ContactPicker } from './catalog/contact-picker'
import { ProductImage } from './catalog/product-image'
import { prepareProductImage } from './catalog/product-photo'
import { api } from '../lib/api'
import { ApiError } from '../lib/api-client'
import { useOperationPeriod } from './operations/period-context'
import type { Product, ProductPage, StockMovement } from '../../shared/catalog'

function ProductEditor({ product, done }: { product: Product | null; done: () => void }) {
  const mutation = useCatalogMutation()
  const period = useOperationPeriod()
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [photoError, setPhotoError] = useState('')
  const [savedId, setSavedId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [preparing, setPreparing] = useState(false)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget))
    const result = savedId ? { id: savedId } : await mutation.run('product.save', {
      name: values.name, price: values.price, purchase_price: values.purchase_price || null,
      ...(product ? { id: product.id, version: product.version } : {}),
      minimum: Number(values.minimum), active: product?.active ?? true,
      quantity: Number(values.quantity), expected_stock: product?.stock ?? 0,
    })
    if (!result || typeof result.id !== 'string') return
    setSavedId(result.id)
    if (photo && period) {
      setUploading(true); setPhotoError('')
      try { await api.uploadProductImage(result.id, photo, product?.image_id ?? null, period) }
      catch (cause) { setPhotoError(cause instanceof ApiError ? cause.message : 'No se pudo adjuntar la fotografía. El producto ya se guardó.'); return }
      finally { setUploading(false) }
    }
    done()
  }
  return <form className="settings-form" onSubmit={save}>
    <fieldset className="business-fieldset" disabled={mutation.busy || uploading || !!savedId}>
    <label className="form-label">Nombre<input name="name" required maxLength={160} pattern=".*\S.*" defaultValue={product?.name} /></label>
    <label className="form-label">Precio de venta<input name="price" type="number" required min="0.01" step="0.01" defaultValue={product?.price} /></label>
    <label className="form-label">Precio de compra<input name="purchase_price" type="number" min="0" step="0.01" defaultValue={product?.purchase_price ?? ''} /></label>
    <label className="form-label">Cantidad disponible<input name="quantity" type="number" required min="0" max="1000000" step="1" defaultValue={product?.stock ?? 0} /></label>
    <label className="form-label">Stock mínimo<input name="minimum" type="number" required min="0" max="1000000" step="1" defaultValue={product?.minimum ?? 0} /></label>
    {product && <ProductImage product={product} />}
    <label className="form-label">Fotografía del producto<input type="file" accept="image/png,image/jpeg,image/webp" onChange={async (event) => {
      const file = event.currentTarget.files?.[0]
      setPhoto(null); setPhotoError(''); setPreparing(true)
      if (!file) { setPreparing(false); return }
      try { setPhoto(await prepareProductImage(file)) }
      catch (cause) { setPhotoError(cause instanceof Error ? cause.message : 'Fotografía no válida.') }
      finally { setPreparing(false) }
    }} /></label><p className="muted">PNG, JPEG o WebP · máximo 2 MiB y 4096 × 4096 píxeles.</p>
    </fieldset>
    {(mutation.error || photoError) && <p role="alert">{mutation.error || photoError}</p>}
    {savedId && photoError && <p>El producto ya se guardó. Reintentar solo adjunta la fotografía y no repite el ajuste de existencias.</p>}
    <Button type="submit" disabled={mutation.busy || uploading || preparing || (!!photoError && !savedId)}>{mutation.busy || uploading || preparing ? 'Guardando…' : savedId ? 'Reintentar fotografía' : 'Guardar producto'}</Button>
  </form>
}

function StockEditor({ product, done }: { product: Product; done: () => void }) {
  const mutation = useCatalogMutation()
  return <form className="settings-form" onSubmit={async (event) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    if (await mutation.run('inventory.adjust', { product_id: product.id, delta: Number(data.get('delta')), reason: data.get('reason'), supplier_id: data.get('supplier_id') || null })) done()
  }}>
    <p>Existencias actuales: {product.stock}. Usa una cantidad positiva para entrada o negativa para salida.</p>
    <label className="form-label">Cantidad de movimiento<input name="delta" type="number" required min="-1000000" max="1000000" step="1" /></label>
    <label className="form-label">Motivo<input name="reason" required pattern=".*\S.*" maxLength={500} /></label>
    <ContactPicker supplier name="supplier_id" label="Proveedor" defaultId={product.supplier_id ?? ''} />
    {mutation.error && <p role="alert">{mutation.error}</p>}
    <Button disabled={mutation.busy} type="submit">{mutation.busy ? 'Guardando…' : 'Registrar movimiento'}</Button>
  </form>
}

function StockHistory({ product }: { product: Product }) {
  const [offset, setOffset] = useState(0)
  const query = useCatalogQuery<StockMovement[]>('inventory.history', { product_id: product.id, limit: 20, offset })
  return <><QueryState {...query} retry={query.refresh} />
    <ul>{query.data?.map((row) => <li key={row.id}>{new Date(row.created_at).toLocaleString('es-CO')} · {row.quantity_delta > 0 ? '+' : ''}{row.quantity_delta} · {row.kind}</li>)}</ul>
    {!query.loading && !query.error && !query.data?.length && <EmptyState text="Sin movimientos registrados." />}
    <Button variant="outline" disabled={!offset} onClick={() => setOffset((value) => Math.max(0, value - 20))}>Anterior</Button>
    <Button variant="outline" disabled={(query.data?.length ?? 0) < 20} onClick={() => setOffset((value) => value + 20)}>Siguiente</Button>
  </>
}

export function Inventory() {
  const { profile } = useAuth()
  const canEdit = profile?.role === 'admin'
  const [search, setSearch] = useState('')
  const [lowOnly, setLowOnly] = useState(window.location.hash.includes('stock=bajo'))
  const [offset, setOffset] = useState(0)
  const [editor, setEditor] = useState<{ kind: 'product' | 'stock' | 'history'; product: Product | null } | null>(null)
  const [notice, setNotice] = useState('')
  const settledSearch = useSearch(search)
  const query = useCatalogQuery<ProductPage>('products.list', { search: settledSearch, low_only: lowOnly, offset, limit: 20 })
  const done = () => { setEditor(null); setNotice('Operación guardada.'); query.refresh() }
  return <>
    <PageHeading title="Inventario" subtitle="Catálogo y existencias registradas en la tienda.">
      {canEdit && <Button onClick={() => setEditor({ kind: 'product', product: null })}>Nuevo producto</Button>}
    </PageHeading>
    {notice && <p role="status">{notice}</p>}
    <Panel><SectionTitle title="Catálogo de productos" subtitle="Productos, fotografías y existencias" />
      <div className="table-toolbar">
        <label className="search-field"><input aria-label="Buscar productos" value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0) }} placeholder="Buscar productos…" maxLength={100} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={lowOnly} onChange={(event) => { setLowOnly(event.target.checked); setOffset(0) }} />Solo stock bajo</label>
        <Button variant="outline" onClick={query.refresh}>Actualizar</Button>
      </div>
      <QueryState {...query} retry={query.refresh} />
      {query.data && <><div className="table-scroll"><table><thead><tr>
        <th>FOTO</th><th>PRODUCTO</th><th>PRECIO</th><th>EXISTENCIAS</th><th>ESTADO</th><th>ACCIONES</th>
      </tr></thead><tbody>{query.data.rows.map((product) => <tr key={product.id}>
        <td><ProductImage product={product} /></td><td><strong>{product.name}</strong></td><td>{money(Number(product.price))}</td><td>{product.stock} unidades</td>
        <td><Badge tone={!product.active ? 'neutral' : product.stock <= product.minimum ? 'amber' : 'green'}>{!product.active ? 'Inactivo' : product.stock <= product.minimum ? 'Stock bajo' : 'Disponible'}</Badge></td>
        <td>{canEdit && <><Button variant="ghost" onClick={() => setEditor({ kind: 'product', product })}>Editar {product.name}</Button><Button variant="ghost" disabled={!product.active} onClick={() => setEditor({ kind: 'stock', product })}>Mover {product.name}</Button></>}
          <Button variant="ghost" onClick={() => setEditor({ kind: 'history', product })}>Historial {product.name}</Button></td>
      </tr>)}</tbody></table>{!query.data.rows.length && <EmptyState />}</div>
        <Pagination offset={offset} total={query.data.total} onChange={setOffset} /></>}
    </Panel>
    {editor && <Dialog open onOpenChange={(open) => { if (!open) setEditor(null) }}
      title={editor.kind === 'product' ? (editor.product ? 'Editar producto' : 'Nuevo producto') : editor.kind === 'stock' ? 'Movimiento de inventario' : 'Historial de inventario'}
      description="Los cambios confirmados se registran en la tienda con el usuario autenticado.">
      {editor.kind === 'product' ? <ProductEditor product={editor.product} done={done} /> : editor.product && (editor.kind === 'stock' ? <StockEditor product={editor.product} done={done} /> : <StockHistory product={editor.product} />)}
    </Dialog>}
  </>
}
