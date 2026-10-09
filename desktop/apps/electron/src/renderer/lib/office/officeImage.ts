import type { OfficeFileKind } from '../../../shared/office-files'
import { downloadOfficeImage, MAX_OFFICE_IMAGE_BYTES, officeImageDataUrl } from '../../../shared/office-images'

export interface OfficeImage {
  dataUrl: string
  base64: string
  extension: 'png' | 'jpeg' | 'gif'
}

/** Embed remote images and convert supported raster/vector formats to portable Office media. */
export async function prepareOfficeImage(source: string, kind: OfficeFileKind): Promise<OfficeImage> {
  let embedded = source.trim()
  if (/^https:\/\//i.test(embedded)) {
    embedded = typeof window !== 'undefined' && window.officeFiles?.readImage
      ? await window.officeFiles.readImage(kind, embedded)
      : await downloadOfficeImage(embedded)
  }
  const match = /^data:image\/(png|jpe?g|gif|bmp|x-ms-bmp|webp|svg\+xml|(?:x-)?wmf|(?:x-)?emf);base64,([a-z0-9+/=\s]+)$/i.exec(embedded)
  if (!match) throw new Error('Use an embedded PNG, JPEG, GIF, BMP, WebP, SVG, WMF or EMF image')
  const mime = match[1]!.toLowerCase()
  const base64 = match[2]!.replace(/\s/g, '')
  if (base64.length > Math.ceil(MAX_OFFICE_IMAGE_BYTES / 3) * 4) throw new Error('The image is too large to embed')
  if (mime === 'png' || mime === 'jpg' || mime === 'jpeg' || mime === 'gif') {
    const extension = mime === 'jpg' ? 'jpeg' : mime
    return { extension, base64, dataUrl: `data:image/${extension};base64,${base64}` }
  }
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
  if (mime === 'svg+xml') return rasterizeOfficeSvg(new TextDecoder().decode(bytes), kind)
  if (/(?:wmf|emf)$/.test(mime)) {
    const { EMFJS, WMFJS } = await import('rtf.js')
    EMFJS.loggingEnabled(false)
    WMFJS.loggingEnabled(false)
    const view = new DataView(bytes.buffer)
    const emf = mime.endsWith('emf')
    let width = 1024
    let height = 768
    if (emf && bytes.length >= 24) {
      width = Math.max(1, view.getInt32(16, true) - view.getInt32(8, true))
      height = Math.max(1, view.getInt32(20, true) - view.getInt32(12, true))
    } else if (!emf && bytes.length >= 22 && view.getUint32(0, true) === 0x9ac6cdd7) {
      width = Math.max(1, view.getInt16(10, true) - view.getInt16(6, true))
      height = Math.max(1, view.getInt16(12, true) - view.getInt16(8, true))
    }
    const scale = Math.min(2, 2048 / Math.max(width, height))
    const pixelWidth = Math.max(1, Math.round(width * scale))
    const pixelHeight = Math.max(1, Math.round(height * scale))
    const settings = { width: `${pixelWidth}px`, height: `${pixelHeight}px`, xExt: pixelWidth, yExt: pixelHeight, wExt: width, hExt: height, mapMode: 8 }
    const svg = emf ? new EMFJS.Renderer(normalizeLegacyEmfHeader(bytes).buffer).render(settings) : new WMFJS.Renderer(bytes.buffer).render(settings)
    if (emf && bytes.length >= 24) {
      // EMF coordinates may be negative. Crop the device frame, not an invented
      // origin-zero viewport that clips valid drawings outside the first quadrant.
      svg.setAttribute('viewBox', `${view.getInt32(8, true)} ${view.getInt32(12, true)} ${width} ${height}`)
      for (const viewport of svg.querySelectorAll('svg')) viewport.setAttribute('overflow', 'visible')
    }
    return rasterizeOfficeSvg(new XMLSerializer().serializeToString(svg), kind)
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${mime}` }))
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image conversion is unavailable')
    context.drawImage(bitmap, 0, 0)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    return prepareOfficeImage(officeImageDataUrl(new Uint8Array(await png.arrayBuffer()), 'image/png'), kind)
  } finally { bitmap.close() }
}

async function rasterizeOfficeSvg(svg: string, kind: OfficeFileKind): Promise<OfficeImage> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        image.onload = null
        image.onerror = null
        if (error) reject(error)
        else resolve()
      }
      const timeout = setTimeout(() => finish(new Error('The Office vector image preview timed out')), 10000)
      image.onload = () => finish()
      image.onerror = () => finish(new Error('The Office vector image could not be rendered'))
      image.src = url
    })
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('The Office image has no dimensions')
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.naturalWidth * scale)), Math.max(1, Math.round(image.naturalHeight * scale)))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image conversion is unavailable')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    return prepareOfficeImage(officeImageDataUrl(new Uint8Array(await png.arrayBuffer()), 'image/png'), kind)
  } finally { URL.revokeObjectURL(url) }
}

/** Legacy EMF descriptions start at byte 88, not in an extension/OpenGL header. */
export function normalizeLegacyEmfHeader(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(bytes)
  if (owned.length < 88) return owned
  const view = new DataView(owned.buffer)
  const size = view.getUint32(4, true)
  const count = view.getUint32(60, true)
  const offset = view.getUint32(64, true)
  if (!count || offset !== 88 || size < offset + count * 2 || size > owned.length) return owned
  const normalized = new Uint8Array(owned.length - (size - 88))
  normalized.set(owned.subarray(0, 88))
  normalized.set(owned.subarray(size), 88)
  const header = new DataView(normalized.buffer)
  header.setUint32(4, 88, true)
  header.setUint32(48, normalized.length, true)
  header.setUint32(60, 0, true)
  header.setUint32(64, 0, true)
  return normalized
}
