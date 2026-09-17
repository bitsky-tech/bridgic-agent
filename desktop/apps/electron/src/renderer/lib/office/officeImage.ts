import type { OfficeFileKind } from '../../../shared/office-files'
import { downloadOfficeImage, MAX_OFFICE_IMAGE_BYTES, officeImageDataUrl } from '../../../shared/office-images'

export interface OfficeImage {
  dataUrl: string
  base64: string
  extension: 'png' | 'jpeg' | 'gif'
}

/** Embed remote images and convert browser-supported rasters to portable Office media. */
export async function prepareOfficeImage(source: string, kind: OfficeFileKind): Promise<OfficeImage> {
  let embedded = source.trim()
  if (/^https:\/\//i.test(embedded)) {
    embedded = typeof window !== 'undefined' && window.officeFiles?.readImage
      ? await window.officeFiles.readImage(kind, embedded)
      : await downloadOfficeImage(embedded)
  }
  const match = /^data:image\/(png|jpe?g|gif|bmp|x-ms-bmp|webp);base64,([a-z0-9+/=\s]+)$/i.exec(embedded)
  if (!match) throw new Error('Use an embedded PNG, JPEG, GIF, BMP or WebP image')
  const mime = match[1]!.toLowerCase()
  const base64 = match[2]!.replace(/\s/g, '')
  if (base64.length > Math.ceil(MAX_OFFICE_IMAGE_BYTES / 3) * 4) throw new Error('The image is too large to embed')
  if (mime === 'png' || mime === 'jpg' || mime === 'jpeg' || mime === 'gif') {
    const extension = mime === 'jpg' ? 'jpeg' : mime
    return { extension, base64, dataUrl: `data:image/${extension};base64,${base64}` }
  }
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
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
