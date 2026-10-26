export async function prepareProductImage(file: File): Promise<Blob> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error('Usa una imagen PNG, JPEG o WebP de hasta 2 MiB.')
  const bitmap = await createImageBitmap(file)
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096 || !bitmap.width || !bitmap.height) throw new Error('La fotografía debe medir como máximo 4096 × 4096 píxeles.')
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No se pudo procesar la fotografía.')
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('No se pudo procesar la fotografía.')), 'image/webp', 0.85))
    if (blob.size > 2 * 1024 * 1024) throw new Error('La fotografía procesada supera 2 MiB.')
    return blob
  } finally { bitmap.close() }
}
