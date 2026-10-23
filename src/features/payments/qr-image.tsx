import { useEffect, useState } from 'react'
import { readQrImage } from './repository'

export function QrImage({
  path,
  name,
  enlarged = false,
  onReady,
}: {
  path: string
  name: string
  enlarged?: boolean
  onReady?: (ready: boolean) => void
}) {
  const [source, setSource] = useState<{ path: string; url: string } | null>(
    null,
  )
  const [failedPath, setFailedPath] = useState('')
  useEffect(() => {
    let disposed = false
    let objectUrl: string | undefined
    onReady?.(false)
    void readQrImage(path)
      .then((value) => {
        if (disposed) return
        if (typeof value !== 'string') objectUrl = URL.createObjectURL(value)
        setSource({ path, url: typeof value === 'string' ? value : objectUrl! })
      })
      .catch(() => {
        if (!disposed) {
          setFailedPath(path)
          onReady?.(false)
        }
      })
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path, onReady])
  if (failedPath === path)
    return (
      <p role="alert" className="payment-error">
        No se puede mostrar este QR. Solicita otra imagen al administrador.
      </p>
    )
  if (source?.path !== path)
    return <p className="muted qr-loading">Cargando imagen QR…</p>
  return (
    <img
      className={`qr-image ${enlarged ? 'qr-enlarged' : ''}`}
      src={source.url}
      alt={`QR fijo de ${name}`}
      onLoad={() => onReady?.(true)}
      onError={() => {
        setFailedPath(path)
        onReady?.(false)
      }}
    />
  )
}
