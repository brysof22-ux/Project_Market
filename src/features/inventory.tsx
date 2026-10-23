import { useState } from 'react'
import { Boxes, Package, Search, TriangleAlert } from 'lucide-react'
import {
  Badge,
  EmptyState,
  Metric,
  Panel,
  SectionTitle,
} from '../components/common'
import { products } from '../data/mock'
import { money } from '../lib/utils'
import { PageHeading } from '../components/common'

export function Inventory() {
  const [search, setSearch] = useState('')
  const [lowOnly, setLowOnly] = useState(
    window.location.hash.includes('stock=bajo'),
  )
  const [category, setCategory] = useState('Todas')
  const filtered = products.filter(
    (product) =>
      `${product.name} ${product.id}`
        .toLocaleLowerCase('es')
        .includes(search.toLocaleLowerCase('es')) &&
      (!lowOnly || product.stock < product.minimum) &&
      (category === 'Todas' || product.category === category),
  )
  return (
    <>
      <PageHeading
        title="Inventario"
        subtitle="Una vista clara de tus productos y sus existencias de ejemplo."
      />
      <div className="metrics-grid three">
        <Metric
          label="Productos de muestra"
          value={String(products.length)}
          change="5 categorías"
          icon={Package}
          note="Catálogo ficticio"
        />
        <Metric
          label="Unidades disponibles"
          value={String(
            products.reduce((sum, product) => sum + product.stock, 0),
          )}
          change="Stock simulado"
          icon={Boxes}
          note="Sin conexión a almacén"
        />
        <Metric
          label="Stock bajo"
          value="3"
          change="Necesitan reposición"
          icon={TriangleAlert}
          note="Según mínimo de muestra"
        />
      </div>
      <Panel>
        <SectionTitle
          title="Catálogo de productos"
          subtitle="Busca por nombre o código de producto"
        />
        <div className="table-toolbar">
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="Buscar productos"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar productos…"
            />
          </label>
          <select
            aria-label="Categoría de inventario"
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
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(e) => setLowOnly(e.target.checked)}
            />
            Solo stock bajo
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>PRODUCTO</th>
                <th>CÓDIGO</th>
                <th>CATEGORÍA</th>
                <th>PRECIO</th>
                <th>EXISTENCIAS</th>
                <th>ESTADO</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((product) => (
                <tr key={product.id}>
                  <td>
                    <div className="person-cell">
                      <span className={`product-image ${product.color}`}>
                        {product.emoji}
                      </span>
                      <strong>{product.name}</strong>
                    </div>
                  </td>
                  <td className="muted">{product.id}</td>
                  <td>{product.category}</td>
                  <td className="amount">{money(product.price)}</td>
                  <td>{product.stock} unidades</td>
                  <td>
                    <Badge
                      tone={product.stock < product.minimum ? 'amber' : 'green'}
                    >
                      {product.stock < product.minimum
                        ? 'Stock bajo'
                        : 'Disponible'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <EmptyState />}
        </div>
        <div className="table-footer">
          {filtered.length} de {products.length} productos de ejemplo · Edición
          y movimientos de inventario pendientes
        </div>
      </Panel>
    </>
  )
}
