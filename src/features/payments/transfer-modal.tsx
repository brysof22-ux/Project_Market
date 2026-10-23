import { useState, type RefObject } from 'react'
import { Check, ShieldCheck, ZoomIn, ZoomOut } from 'lucide-react'
import { Dialog } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { QrImage } from './qr-image'
import { usePayments } from './use-payments'
import { listTransferMethods, makeManualConfirmation } from './repository'
import { formatPaymentMoney, type TransferDraft } from './types'

export function TransferModal({
  open,
  onOpenChange,
  amountMinor,
  onConfirm,
  returnFocusRef,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  amountMinor: number
  onConfirm: (draft: TransferDraft) => void
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const { methods, actor, refresh } = usePayments()
  const active = methods.filter((method) => method.active)
  const [selected, setSelected] = useState(active[0]?.id ?? '')
  const method = active.find((item) => item.id === selected) ?? active[0]
  const identity = `${method?.id}:${method?.revision}:${amountMinor}`
  const [proof, setProof] = useState({
    identity: '',
    reference: '',
    verified: false,
  })
  const reference = proof.identity === identity ? proof.reference : ''
  const verified = proof.identity === identity && proof.verified
  function setReference(value: string) {
    setProof({ identity, reference: value, verified })
  }
  function setVerified(value: boolean) {
    setProof({ identity, reference, verified: value })
  }
  const [imageReady, setImageReady] = useState(false)
  const [enlarged, setEnlarged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function confirm() {
    if (
      busy ||
      !method ||
      !imageReady ||
      !verified ||
      !reference.trim() ||
      reference.trim().length > 100 ||
      amountMinor <= 0
    )
      return
    setBusy(true)
    setError('')
    try {
      const current = (await listTransferMethods()).find(
        (item) => item.id === method.id,
      )
      if (!current?.active || current.revision !== method.revision) {
        await refresh()
        setVerified(false)
        setReference('')
        throw new Error(
          'Este QR cambió o fue desactivado. Revisa el método y verifica de nuevo.',
        )
      }
      onConfirm(makeManualConfirmation(actor, method, amountMinor, reference))
      onOpenChange(false)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'No se pudo confirmar la demostración.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      returnFocusRef={returnFocusRef}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value)
      }}
      title="Pago por transferencia"
      description="Demostración local · No hay conexión bancaria. Mostrar el QR o escribir una referencia no verifica el pago."
    >
      <div className="transfer-amount">
        <span>Importe exacto a transferir</span>
        <strong>{formatPaymentMoney(amountMinor)}</strong>
      </div>
      {!method ? (
        <div className="notice">
          No hay QR activos. Solicita al administrador configurar uno en Métodos
          de pago.
        </div>
      ) : (
        <>
          <label className="form-label">
            Cuenta para la transferencia
            <select
              aria-label="QR para la transferencia"
              value={method.id}
              disabled={busy}
              onChange={(event) => {
                setSelected(event.target.value)
                setReference('')
                setVerified(false)
                setImageReady(false)
                setEnlarged(false)
                setError('')
              }}
            >
              {active.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="transfer-identity">
            <strong>{method.institution}</strong>
            <span>Titular: {method.holder}</span>
          </div>
          <div className="qr-display">
            <QrImage
              key={`${method.id}:${method.revision}`}
              path={method.imagePath}
              name={method.name}
              enlarged={enlarged}
              onReady={setImageReady}
            />
          </div>
          <Button
            variant="ghost"
            className="qr-zoom"
            onClick={() => setEnlarged((value) => !value)}
            aria-pressed={enlarged}
          >
            {enlarged ? <ZoomOut size={15} /> : <ZoomIn size={15} />}
            {enlarged ? 'Reducir QR' : 'Ampliar QR'}
          </Button>
          <p className="qr-static-note">
            QR fijo: comprueba e introduce el importe indicado en tu aplicación
            bancaria. Los QR de ejemplo no permiten realizar pagos.
          </p>
          <label className="form-label">
            Referencia bancaria
            <input
              value={reference}
              maxLength={100}
              disabled={busy}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Ej. referencia de la transferencia"
              autoComplete="off"
            />
          </label>
          <label className="manual-verification">
            <input
              type="checkbox"
              checked={verified}
              disabled={busy}
              onChange={(event) => setVerified(event.target.checked)}
            />
            <span>
              He verificado el ingreso del dinero antes de confirmar. En esta
              demostración, solo ensayo este paso.
            </span>
          </label>
          <div className="verification-note">
            <ShieldCheck size={16} />
            <span>
              Confirmación manual por {actor.name}. No es una validación
              bancaria.
            </span>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="payment-error">
          {error}
        </p>
      )}
      <div className="payment-dialog-actions">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onOpenChange(false)}
        >
          Cancelar
        </Button>
        <Button
          disabled={
            !method ||
            !imageReady ||
            !verified ||
            !reference.trim() ||
            busy ||
            amountMinor <= 0
          }
          onClick={() => {
            void confirm()
          }}
        >
          <Check size={16} />
          {busy ? 'Confirmando…' : 'Confirmar pago recibido'}
        </Button>
      </div>
      <p className="fine-print">
        La confirmación se incorporará al historial local al finalizar la venta
        simulada.
      </p>
    </Dialog>
  )
}
