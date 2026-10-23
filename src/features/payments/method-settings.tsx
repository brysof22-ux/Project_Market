import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react'
import { Pencil, Plus, QrCode, ShieldCheck } from 'lucide-react'
import { Badge, Panel, SectionTitle } from '../../components/common'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { usePayments } from './use-payments'
import { QrImage } from './qr-image'
import { validateQrFile } from './repository'
import type { DemoRole, TransferMethod } from './types'

const labels: Record<DemoRole, string> = {
  admin: 'Administrador',
  supervisor: 'Supervisor',
  cashier: 'Cajero',
}
export function DemoPermissions() {
  const { actor, setDemoRole } = usePayments()
  return (
    <Panel>
      <SectionTitle
        title="Usuarios y permisos"
        subtitle="Permisos de prueba · No modifica tu cuenta real"
      />
      <label className="form-label mt-5">
        Rol de demostración
        <select
          value={actor.role}
          onChange={(event) => setDemoRole(event.target.value as DemoRole)}
        >
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted mt-3">
        Este selector permite probar las restricciones visuales. En producción,
        el rol deberá verificarse en el backend con Supabase Auth.
      </p>
    </Panel>
  )
}

export function MethodSettings() {
  const { actor, methods, ready, error, saveMethod } = usePayments()
  const [editing, setEditing] = useState<TransferMethod | 'new' | null>(null)
  const [actionError, setActionError] = useState('')
  const [savingId, setSavingId] = useState('')
  const editorTrigger = useRef<HTMLButtonElement>(null)
  const admin = actor.role === 'admin'
  async function toggle(method: TransferMethod) {
    setSavingId(method.id)
    setActionError('')
    try {
      await saveMethod({
        ...method,
        active: !method.active,
        expectedRevision: method.revision,
      })
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : 'No se pudo guardar el método.',
      )
    } finally {
      setSavingId('')
    }
  }
  return (
    <Panel className="payment-settings">
      <SectionTitle
        title="Métodos de pago"
        subtitle="QR fijos para transferencias · Configuración local de demostración"
        action={
          admin && (
            <Button
              disabled={!ready}
              onClick={(event) => {
                editorTrigger.current = event.currentTarget
                setEditing('new')
              }}
            >
              <Plus size={15} />
              Agregar QR
            </Button>
          )
        }
      />
      <div className="payment-local-note">
        <ShieldCheck size={16} />
        <p>
          {admin
            ? 'Solo el perfil administrador puede añadir, cambiar o desactivar QR en esta demostración.'
            : 'Solo lectura: únicamente el administrador puede modificar los QR.'}{' '}
          Imágenes e historial se guardan en este navegador; no hay
          almacenamiento remoto.
        </p>
      </div>
      {(error || actionError) && (
        <p role="alert" className="payment-error">
          {error || actionError}
        </p>
      )}
      {!ready && !error && <p className="muted">Cargando métodos locales…</p>}
      <div className="transfer-method-grid">
        {methods.map((method) => (
          <article className="transfer-method-card" key={method.id}>
            <div className="method-card-top">
              <span className="metric-icon">
                <QrCode size={17} />
              </span>
              <Badge tone={method.active ? 'green' : 'neutral'}>
                {method.active ? 'Activo' : 'Inactivo'}
              </Badge>
            </div>
            <div className="method-card-body">
              <div className="method-mini-qr">
                <QrImage path={method.imagePath} name={method.name} />
              </div>
              <div>
                <h3>{method.name}</h3>
                <p>{method.institution}</p>
                <small>Titular: {method.holder}</small>
              </div>
            </div>
            <div className="method-meta">
              Versión {method.revision} ·{' '}
              {new Date(method.updatedAt).toLocaleDateString('es-CO')}
              <br />
              Responsable: {method.updatedBy}
            </div>
            {admin && (
              <div className="method-card-actions">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(event) => {
                    editorTrigger.current = event.currentTarget
                    setEditing(method)
                  }}
                >
                  <Pencil size={13} />
                  Editar QR
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={savingId === method.id}
                  onClick={() => {
                    void toggle(method)
                  }}
                >
                  {method.active ? 'Desactivar' : 'Activar'}
                </Button>
              </div>
            )}
          </article>
        ))}
      </div>
      <p className="fine-print">
        Los dos QR iniciales son ejemplos sin datos bancarios. Carga tus
        imágenes para ensayar la configuración; no realices transferencias desde
        este prototipo.
      </p>
      {editing && admin && (
        <MethodEditor
          key={editing === 'new' ? 'new' : editing.id}
          method={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          returnFocusRef={editorTrigger}
        />
      )}
    </Panel>
  )
}

function MethodEditor({
  method,
  onClose,
  returnFocusRef,
}: {
  method: TransferMethod | null
  onClose: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const { saveMethod } = usePayments()
  const [name, setName] = useState(method?.name ?? '')
  const [institution, setInstitution] = useState(method?.institution ?? '')
  const [holder, setHolder] = useState(method?.holder ?? '')
  const [active, setActive] = useState(method?.active ?? true)
  const [image, setImage] = useState<Blob>()
  const [preview, setPreview] = useState('')
  const [processing, setProcessing] = useState(false)
  const [fileError, setFileError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const uploadSequence = useRef(0)
  const resourceRef = useRef({ previewUrl: '', disposed: false })
  useEffect(() => {
    const resources = resourceRef.current
    resources.disposed = false
    return () => {
      resources.disposed = true
      if (resources.previewUrl) URL.revokeObjectURL(resources.previewUrl)
    }
  }, [])
  async function upload(file?: File) {
    const resources = resourceRef.current
    const sequence = ++uploadSequence.current
    setImage(undefined)
    if (resources.previewUrl) URL.revokeObjectURL(resources.previewUrl)
    resources.previewUrl = ''
    setPreview('')
    setFileError('')
    setError('')
    if (!file) {
      setProcessing(false)
      return
    }
    setProcessing(true)
    try {
      const valid = await validateQrFile(file)
      if (sequence === uploadSequence.current && !resources.disposed) {
        setImage(valid)
        resources.previewUrl = URL.createObjectURL(valid)
        setPreview(resources.previewUrl)
      }
    } catch (cause) {
      if (sequence === uploadSequence.current && !resources.disposed)
        setFileError(
          cause instanceof Error ? cause.message : 'Imagen inválida.',
        )
    } finally {
      if (sequence === uploadSequence.current && !resources.disposed)
        setProcessing(false)
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (processing || saving || fileError) return
    setSaving(true)
    setError('')
    try {
      await saveMethod(
        {
          id: method?.id ?? crypto.randomUUID(),
          name,
          institution,
          holder,
          active,
          expectedRevision: method?.revision,
        },
        image,
      )
      onClose()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'No se pudo guardar el método local.',
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog
      open
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
      title={
        method
          ? 'Editar método de transferencia'
          : 'Agregar método de transferencia'
      }
      description="Configuración de demostración. Guarda una imagen QR fija; el sistema no genera códigos ni confirma operaciones bancarias."
    >
      <form
        className="payment-method-form"
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <label className="form-label">
          Nombre del QR
          <input
            required
            maxLength={100}
            pattern=".*\S.*"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ej. Cuenta principal"
          />
        </label>
        <label className="form-label">
          Entidad financiera o billetera
          <input
            required
            maxLength={100}
            pattern=".*\S.*"
            value={institution}
            onChange={(event) => setInstitution(event.target.value)}
          />
        </label>
        <label className="form-label">
          Nombre del titular
          <input
            required
            maxLength={100}
            pattern=".*\S.*"
            value={holder}
            onChange={(event) => setHolder(event.target.value)}
          />
        </label>
        <label className="form-label">
          Imagen QR
          <input
            type="file"
            aria-label="Imagen QR"
            aria-describedby="qr-file-limits"
            accept="image/png,image/jpeg,image/webp"
            disabled={saving}
            onChange={(event) => {
              void upload(event.target.files?.[0])
            }}
          />
          <span className="muted" id="qr-file-limits">
            PNG, JPG o WebP · Máximo 2 MB · De 64 a 4096 px por lado.
          </span>
        </label>
        {processing && <p className="muted">Validando imagen…</p>}
        {fileError && (
          <p role="alert" className="payment-error">
            {fileError}
          </p>
        )}
        {(preview || method) && (
          <div className="qr-upload-preview">
            {preview ? (
              <img src={preview} alt="Vista previa del QR cargado" />
            ) : (
              method && <QrImage path={method.imagePath} name={method.name} />
            )}
          </div>
        )}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          Método activo
        </label>
        {error && (
          <p role="alert" className="payment-error">
            {error}
          </p>
        )}
        <div className="payment-dialog-actions">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            disabled={
              saving || processing || !!fileError || (!method && !image)
            }
          >
            {saving ? 'Guardando…' : 'Guardar método'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
