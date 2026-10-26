import { CatalogError } from './catalog'

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const fail = (): never => { throw new CatalogError(415, 'INVALID_IMAGE', 'Adjunta una imagen PNG, JPEG o WebP válida de hasta 4096 píxeles por lado.') }
const dimensions = (width: number, height: number) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 4096 || height > 4096 || width * height > 16_000_000) fail()
  return { width, height }
}
const concatenate = (parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
const text = (bytes: Uint8Array, from: number, count: number) => String.fromCharCode(...bytes.subarray(from, from + count))
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff
  for (const value of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

// Bounded container validation, not an image decoder. Only raster MIME types
// are served with nosniff; metadata is removed before storage. No SVG/HTML,
// external resource references, original filenames, EXIF, XMP or text chunks.
export function prepareImage(bytes: Uint8Array, mime: string): { bytes: Uint8Array; mime: string; width: number; height: number } {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png') {
    if (bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) fail()
    const parts = [bytes.subarray(0, 8)]
    let offset = 8, width = 0, height = 0, imageData = false, ended = false, palette = false, color = -1
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), kind = text(bytes, offset + 4, 4), end = offset + 12 + length
      if (end > bytes.length || !/^[A-Za-z]{4}$/.test(kind)
        || crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) fail()
      if (offset === 8 && (kind !== 'IHDR' || length !== 13)) fail()
      if (kind === 'IHDR') {
        if (offset !== 8 || length !== 13) fail()
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12)
        dimensions(width, height)
        const depth = bytes[offset + 16]; color = bytes[offset + 17]
        const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
        if (!depths[color]?.includes(depth) || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20] > 1) fail()
      } else if (kind === 'PLTE') {
        if (imageData || palette || !length || length % 3 || length > 768) fail()
        palette = true
      } else if (kind === 'IDAT') {
        if (color === 3 && !palette) fail()
        imageData = imageData || length > 0
      } else if (kind === 'IEND') {
        if (length || !imageData || end !== bytes.length) fail()
        ended = true
      } else if (kind[0] === kind[0].toUpperCase()) fail() // Unknown critical chunk.
      if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(kind)) parts.push(bytes.subarray(offset, end))
      offset = end
      if (ended) break
    }
    if (!ended || offset !== bytes.length) fail()
    return { bytes: concatenate(parts), mime, width, height }
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 20 || bytes[0] !== 255 || bytes[1] !== 216) fail()
    const parts = [bytes.subarray(0, 2)]
    let offset = 2, width = 0, height = 0, scan = false, ended = false
    while (offset < bytes.length) {
      const start = offset
      if (bytes[offset++] !== 255) fail()
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 217) {
        if (!scan || !width || offset !== bytes.length) fail()
        parts.push(bytes.subarray(start, offset)); ended = true; break
      }
      if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215) || offset + 2 > bytes.length) fail()
      const length = view.getUint16(offset), end = offset + length
      if (length < 2 || end > bytes.length) fail()
      if ([192, 193, 194].includes(marker)) {
        if (width || length < 8 || bytes[offset + 2] !== 8) fail()
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5)
        dimensions(width, height)
        const components = bytes[offset + 7]
        if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) fail()
      } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) fail()
      // APPn and COM can contain location, device identifiers and personal text.
      if (!(marker >= 224 && marker <= 239) && marker !== 254) parts.push(bytes.subarray(start, end))
      offset = end
      if (marker === 218) {
        if (!width || length < 6) fail()
        scan = true
        const entropyStart = offset
        while (offset < bytes.length) {
          if (bytes[offset] !== 255) { offset++; continue }
          if (bytes[offset + 1] === 0 || (bytes[offset + 1] >= 208 && bytes[offset + 1] <= 215)) { offset += 2; continue }
          break
        }
        if (offset === entropyStart || offset >= bytes.length) fail()
        parts.push(bytes.subarray(entropyStart, offset))
      }
    }
    if (!ended) fail()
    return { bytes: concatenate(parts), mime, width, height }
  }
  if (mime === 'image/webp') {
    if (bytes.length < 26 || text(bytes, 0, 4) !== 'RIFF' || text(bytes, 8, 4) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) fail()
    const parts: Uint8Array[] = []
    let offset = 12, width = 0, height = 0, declaredWidth = 0, declaredHeight = 0
    while (offset + 8 <= bytes.length) {
      const kind = text(bytes, offset, 4), length = view.getUint32(offset + 4, true), end = offset + 8 + length + (length & 1)
      if (end > bytes.length || !length || ((length & 1) && bytes[end - 1] !== 0)) fail()
      if (kind === 'VP8X') {
        if (offset !== 12 || length !== 10 || (bytes[offset + 8] & 0x02)) fail() // No animation.
        declaredWidth = 1 + bytes[offset + 12] + (bytes[offset + 13] << 8) + (bytes[offset + 14] << 16)
        declaredHeight = 1 + bytes[offset + 15] + (bytes[offset + 16] << 8) + (bytes[offset + 17] << 16)
        dimensions(declaredWidth, declaredHeight)
        const chunk = bytes.slice(offset, end); chunk[8] &= 0x10 // Keep alpha only, clear metadata flags.
        parts.push(chunk)
      } else if (kind === 'VP8 ' || kind === 'VP8L') {
        if (width) fail()
        const start = offset + 8
        if (kind === 'VP8 ') {
          if (length < 10 || (bytes[start] & 1) || ![157, 1, 42].every((value, index) => bytes[start + 3 + index] === value)) fail()
          width = view.getUint16(start + 6, true) & 0x3fff; height = view.getUint16(start + 8, true) & 0x3fff
        } else {
          if (length < 5 || bytes[start] !== 47 || bytes[start + 4] >> 5) fail()
          width = 1 + ((bytes[start + 2] & 63) << 8) + bytes[start + 1]
          height = 1 + ((bytes[start + 4] & 15) << 10) + (bytes[start + 3] << 2) + (bytes[start + 2] >> 6)
        }
        dimensions(width, height)
        parts.push(bytes.subarray(offset, end))
      } else if (kind === 'ALPH') parts.push(bytes.subarray(offset, end))
      else if (!['EXIF', 'XMP ', 'ICCP'].includes(kind)) fail()
      offset = end
    }
    if (!width || offset !== bytes.length || (declaredWidth && (width !== declaredWidth || height !== declaredHeight))) fail()
    const result = concatenate([bytes.subarray(0, 12), ...parts])
    new DataView(result.buffer).setUint32(4, result.length - 8, true)
    return { bytes: result, mime, width, height }
  }
  return fail()
}
