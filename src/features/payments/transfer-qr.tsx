import { useEffect, useState } from 'react'
import type { TransferQR } from '../../../shared/catalog'
import { api } from '../../lib/api'
import { useCatalogQuery } from '../catalog/hooks'
import { QueryState } from '../catalog/common'
import { Panel, SectionTitle } from '../../components/common'
import { Dialog } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'

export function RemoteQR({ method, onReady }: { method: TransferQR; onReady?: (ready: boolean) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState(method.image_id ? '' : 'QR pendiente de configuración por el administrador.')
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    onReady?.(false)
    if (method.image_id) void api.transferQRImage(method.code, controller.signal, method.image_id).then((blob) => {
      if (!controller.signal.aborted) {
        if (!blob) { setError('QR no disponible. Contacta al administrador.'); return }
        objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
      }
    }).catch(() => { if (!controller.signal.aborted) setError('No se pudo cargar el QR. Actualiza los métodos de pago.') })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [method.code, method.image_id, onReady])
  return <div className="transfer-qr-image">{url && <img src={url} alt={`Código QR ${method.name}`} onLoad={() => onReady?.(true)} onError={() => { onReady?.(false); setError('Imagen QR no válida.') }} />}{url && <Button type="button" variant="outline" onClick={() => setExpanded(true)}>Ampliar QR {method.name}</Button>}{expanded && url && <Dialog open onOpenChange={setExpanded} title={`QR ${method.name}`} description="Comprueba el destinatario y el importe antes de transferir."><img className="transfer-qr-expanded" src={url} alt={`QR ampliado ${method.name}`} /></Dialog>}{error && <p role="alert">{error}</p>}</div>
}
export function TransferPicker({ onSelect, onReady }: { onSelect: (method: TransferQR | null) => void; onReady: (ready: boolean) => void }) {
  const query = useCatalogQuery<TransferQR[]>('qr.list', {})
  const [code, setCode] = useState('nequi')
  const method = query.data?.find((row) => row.code === code)
  useEffect(() => { onSelect(method ?? null) }, [method, onSelect])
  return <section className="transfer-qr-panel" aria-label="Pago por transferencia">
    <SectionTitle title="Transferencia" subtitle="Elige el QR que el cliente desea escanear." />
    <QueryState {...query} retry={query.refresh} />
    <label className="form-label">QR de transferencia<select aria-label="QR de transferencia" value={code} onChange={(event) => { onReady(false); setCode(event.target.value) }}>
      <option value="nequi">Nequi</option><option value="breb">Llaves Bre-B</option>
    </select></label>
    {method && <RemoteQR key={`${method.code}:${method.image_id}`} method={method} onReady={onReady} />}
    <Button type="button" variant="outline" onClick={() => { onReady(false); query.refresh() }}>Actualizar QR</Button>
    <p className="muted">El cliente debe comprobar el destinatario y el importe. Escanear el QR no registra el pago. Verifica que el dinero haya sido recibido antes de confirmar la venta.</p>
  </section>
}
function QREditor({ method, refresh }: { method: TransferQR; refresh: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  return <Panel><SectionTitle title={method.name} /><RemoteQR key={`${method.code}:${method.image_id}`} method={method} />
    <form className="settings-form" onSubmit={async (event) => {
      event.preventDefault(); if (!file || busy) return
      const form = event.currentTarget
      setBusy(true); setError(''); setNotice('')
      try {
        await api.uploadTransferQRImage(method.code, file, method.image_id)
        setFile(null); setNotice('QR actualizado.'); form.reset(); refresh()
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo actualizar el QR.') }
      finally { setBusy(false) }
    }}>
      <label className="form-label">Reemplazar QR {method.name}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={async (event) => {
        setFile(null); setError(''); setNotice('')
        const selected = event.currentTarget.files?.[0]
        if (!selected) return
        try {
          if (!['image/png','image/jpeg','image/webp'].includes(selected.type) || selected.size > 2 * 1024 * 1024) throw new Error('Usa PNG, JPEG o WebP de hasta 2 MiB.')
          const bitmap = await createImageBitmap(selected)
          const valid = bitmap.width >= 64 && bitmap.height >= 64 && bitmap.width <= 4096 && bitmap.height <= 4096 && bitmap.width * bitmap.height <= 16000000
          bitmap.close()
          if (!valid) throw new Error('El QR debe medir entre 64 y 4096 píxeles por lado (máximo 16 megapíxeles).')
          setFile(selected)
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Imagen no válida.') }
      }} /></label>
      <p className="muted">PNG, JPEG o WebP · máximo 2 MiB. Se conserva el QR original; no se generan códigos nuevos.</p>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      <Button type="submit" disabled={!file || busy}>{busy ? 'Guardando…' : `Guardar QR ${method.name}`}</Button>
    </form>
  </Panel>
}
export function TransferSettings() {
  const query = useCatalogQuery<TransferQR[]>('qr.list', {})
  return <section aria-label="Métodos de pago"><SectionTitle title="Métodos de pago" subtitle="Códigos QR de transferencia. Solo los administradores pueden reemplazarlos." />
    <QueryState {...query} retry={query.refresh} /><div className="settings-grid">{query.data?.map((method) => <QREditor key={method.code} method={method} refresh={query.refresh} />)}</div>
  </section>
}
