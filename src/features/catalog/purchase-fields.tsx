import { useState } from 'react'
import { purchasePreview } from '../../../shared/money'
export function PurchaseFields({ stock }: { stock: number }) {
 const [quantity,setQuantity]=useState('0'),[total,setTotal]=useState('0')
 const preview=purchasePreview(quantity,total,stock)
 return <>
  <label className="form-label">Cantidad actual<input readOnly value={stock} /></label>
  <label className="form-label">Cantidad a ingresar<input name="incoming_quantity" type="number" required min="0" max="1000000" step="1" value={quantity} onChange={event=>setQuantity(event.target.value)} /></label>
  <label className="form-label">Precio total de compra<input name="purchase_total" inputMode="decimal" required value={total} onChange={event=>setTotal(event.target.value)} placeholder="20.173,00" /></label>
  <label className="form-label">Precio de compra unitario<input readOnly value={preview.unit===null?'Sin unidades nuevas':preview.unit.toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:6})} /></label>
  <label className="form-label">Cantidad disponible resultante<input readOnly value={preview.available} /></label>
  {!preview.valid && <p role="alert">Ingresa unidades enteras no negativas y un total válido en pesos. Sin unidades nuevas, el total debe ser cero.</p>}
  <p className="muted">Las unidades se suman al guardar. El costo vigente se calcula con promedio ponderado; si falta el costo anterior no se inventa una valoración.</p>
 </>
}
