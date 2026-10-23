import {
  MAX_QR_BYTES,
  type DemoPayment,
  type DemoSale,
  type MethodChange,
  type PaymentActor,
  type TransferMethod,
  type TransferDraft,
} from './types'

const seeds: TransferMethod[] = [
  {
    id: 'bank-demo',
    name: 'Banco principal · Demo',
    institution: 'Banco de ejemplo',
    holder: 'CAI Market · Ejemplo',
    imagePath: '/demo-qr/banco-demo.png',
    active: true,
    revision: 1,
    updatedAt: '2026-10-23T14:00:00Z',
    updatedBy: 'Administrador demo',
  },
  {
    id: 'wallet-demo',
    name: 'Billetera · Demo',
    institution: 'Billetera de ejemplo',
    holder: 'CAI Market · Ejemplo',
    imagePath: '/demo-qr/billetera-demo.png',
    active: true,
    revision: 1,
    updatedAt: '2026-10-23T14:00:00Z',
    updatedBy: 'Administrador demo',
  },
]
let connection: Promise<IDBDatabase> | undefined
function database() {
  if (!connection)
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('cai-market-payments-demo-v1', 1)
      request.onupgradeneeded = () => {
        const db = request.result
        const methods = db.createObjectStore('methods', { keyPath: 'id' })
        seeds.forEach((method) => methods.add(method))
        db.createObjectStore('images')
        const sales = db.createObjectStore('sales', { keyPath: 'id' })
        sales.createIndex('operationKey', 'operationKey', { unique: true })
        db.createObjectStore('methodChanges', { keyPath: 'id' })
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close()
          connection = undefined
        }
        resolve(request.result)
      }
      request.onerror = () => {
        connection = undefined
        reject(
          new Error(
            'No se pudo abrir el almacenamiento local de demostración.',
          ),
        )
      }
      request.onblocked = () =>
        reject(
          new Error(
            'Cierra otras pestañas para habilitar el almacenamiento de demostración.',
          ),
        )
    })
  return connection
}
function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
function completed(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('No se guardaron los datos locales.'))
  })
}
async function all<T>(store: string) {
  const db = await database()
  return result<T[]>(db.transaction(store).objectStore(store).getAll())
}
export const listTransferMethods = () => all<TransferMethod>('methods')
export const listDemoSales = async () =>
  (await all<DemoSale>('sales')).sort((a, b) =>
    b.confirmedAt.localeCompare(a.confirmedAt),
  )
export function requireAdmin(actor: PaymentActor) {
  if (actor.role !== 'admin')
    throw new Error(
      'Solo el administrador puede modificar los métodos de transferencia.',
    )
}

export async function validateQrFile(file: File): Promise<Blob> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    !/\.(png|jpe?g|webp)$/i.test(file.name)
  )
    throw new Error('Admite únicamente imágenes PNG, JPG o WebP.')
  if (file.size === 0 || file.size > MAX_QR_BYTES)
    throw new Error('La imagen debe pesar como máximo 2 MB y no estar vacía.')
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every(
    (byte, index) => bytes[index] === byte,
  )
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp =
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  if (!(
    (file.type === 'image/png' && png) ||
    (file.type === 'image/jpeg' && jpeg) ||
    (file.type === 'image/webp' && webp)
  ))
    throw new Error('El contenido de la imagen no coincide con su formato.')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('No se pudo leer la imagen. Selecciona un archivo válido.')
  }
  try {
    if (
      bitmap.width < 64 ||
      bitmap.height < 64 ||
      bitmap.width > 4096 ||
      bitmap.height > 4096
    )
      throw new Error('La imagen debe medir entre 64 y 4096 píxeles por lado.')
    // Normalize pixels and remove embedded metadata; never render uploaded SVG/HTML.
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No se pudo procesar la imagen.')
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error('No se pudo procesar la imagen.')),
        'image/png',
      ),
    )
    if (blob.size > MAX_QR_BYTES)
      throw new Error(
        'La imagen procesada supera 2 MB. Usa una imagen más pequeña.',
      )
    return blob
  } finally {
    bitmap.close()
  }
}

export async function saveTransferMethod(
  actor: PaymentActor,
  input: Omit<
    TransferMethod,
    'imagePath' | 'revision' | 'updatedAt' | 'updatedBy'
  > & { expectedRevision?: number },
  image?: Blob,
) {
  requireAdmin(actor)
  for (const field of [input.name, input.institution, input.holder])
    if (!field.trim() || field.trim().length > 100)
      throw new Error(
        'Nombre, entidad y titular son obligatorios (máximo 100 caracteres).',
      )
  if (image && (image.type !== 'image/png' || image.size > MAX_QR_BYTES))
    throw new Error('La imagen no ha pasado la validación de carga.')
  const db = await database()
  const tx = db.transaction(['methods', 'images', 'methodChanges'], 'readwrite')
  const done = completed(tx)
  try {
    const store = tx.objectStore('methods')
    const old = await result<TransferMethod | undefined>(store.get(input.id))
    if (old && old.revision !== input.expectedRevision)
      throw new Error(
        'El método cambió en otra pestaña. Actualiza y vuelve a intentarlo.',
      )
    if (!old && !image)
      throw new Error('Carga una imagen QR para registrar el método.')
    const method: TransferMethod = {
      id: input.id,
      name: input.name.trim(),
      institution: input.institution.trim(),
      holder: input.holder.trim(),
      active: input.active,
      revision: (old?.revision ?? 0) + 1,
      imagePath: image
        ? `demo-images/${crypto.randomUUID()}.png`
        : old!.imagePath,
      updatedBy: actor.name,
      updatedAt: new Date().toISOString(),
    }
    if (image) tx.objectStore('images').add(image, method.imagePath)
    store.put(method)
    const change: MethodChange = {
      id: crypto.randomUUID(),
      methodId: method.id,
      actor: { ...actor },
      at: method.updatedAt,
      before: old ?? null,
      after: method,
    }
    tx.objectStore('methodChanges').add(change)
    await done
    return method
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* Already aborted. */
    }
    await done.catch(() => {})
    throw error
  }
}

export async function readQrImage(path: string): Promise<Blob | string> {
  if (seeds.some((method) => method.imagePath === path)) return path
  const db = await database()
  const image = await result<Blob | undefined>(
    db.transaction('images').objectStore('images').get(path),
  )
  if (!image)
    throw new Error(
      'La imagen QR ya no está disponible. Solicita su configuración al administrador.',
    )
  return image
}

export async function commitDemoSale(sale: DemoSale) {
  if (
    sale.mode !== 'demo' ||
    !Number.isSafeInteger(sale.totalMinor) ||
    sale.totalMinor <= 0 ||
    !sale.payments.length ||
    sale.payments.some(
      (payment) =>
        !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0,
    ) ||
    sale.payments.reduce((sum, payment) => sum + payment.amountMinor, 0) !==
      sale.totalMinor
  )
    throw new Error('Los pagos deben coincidir exactamente con el total.')
  const db = await database()
  const tx = db.transaction(['methods', 'sales'], 'readwrite')
  const done = completed(tx)
  try {
    const previous = await result<DemoSale | undefined>(
      tx.objectStore('sales').index('operationKey').get(sale.operationKey),
    )
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(sale))
        throw new Error('La operación ya fue registrada con otros datos.')
      await done
      return previous
    }
    for (const payment of sale.payments.filter(
      (payment) => payment.kind === 'transfer',
    )) {
      const draft = payment.transfer
      const method =
        draft &&
        (await result<TransferMethod | undefined>(
          tx.objectStore('methods').get(draft.methodId),
        ))
      if (
        !draft ||
        !method?.active ||
        method.revision !== draft.revision ||
        draft.amountMinor !== payment.amountMinor ||
        !draft.reference.trim() ||
        draft.confirmation !== 'manual-demo' ||
        draft.confirmedBy.id !== sale.actor.id ||
        !draft.confirmedAt
      )
        throw new Error(
          'Vuelve a verificar la transferencia: el importe, el QR o la confirmación cambiaron.',
        )
    }
    tx.objectStore('sales').add(sale)
    await done
    return sale
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* Already aborted. */
    }
    await done.catch(() => {})
    throw error
  }
}
export function summarizeDemoPayments(sales: DemoSale[]) {
  const totals = { cash: 0, transfer: 0, card: 0 }
  for (const sale of sales)
    for (const payment of sale.payments)
      totals[payment.kind as DemoPayment['kind']] += payment.amountMinor
  return totals
}

export function makeManualConfirmation(
  actor: PaymentActor,
  method: TransferMethod,
  amountMinor: number,
  reference: string,
): TransferDraft {
  return {
    methodId: method.id,
    revision: method.revision,
    amountMinor,
    reference: reference.trim(),
    confirmedBy: { ...actor },
    confirmedAt: new Date().toISOString(),
    confirmation: 'manual-demo',
  }
}
