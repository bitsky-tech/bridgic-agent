export const MAX_OFFICE_IMAGE_BYTES = 20 * 1024 * 1024

export function officeImageDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return `data:${mime};base64,${btoa(binary)}`
}

/** Fetch through the host without renderer CORS restrictions or browser credentials. */
export async function downloadOfficeImage(source: string): Promise<string> {
  const signal = AbortSignal.timeout(15_000)
  let url = new URL(source)
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Office image URLs must use HTTPS without credentials')
    const response = await fetch(url.href, { credentials: 'omit', redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('The image redirect has no destination')
      url = new URL(location, url)
      continue
    }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const fail = async (message: string): Promise<never> => { await response.body?.cancel(); throw new Error(message) }
    if (!response.ok) return fail(`The image could not be downloaded (${response.status})`)
    if (!/^image\/(png|jpe?g|gif|bmp|x-ms-bmp|webp)$/.test(mime)) return fail('The URL must return a PNG, JPEG, GIF, BMP or WebP image')
    if (Number(response.headers.get('content-length')) > MAX_OFFICE_IMAGE_BYTES) return fail('The image is too large to embed')
    if (!response.body) throw new Error('The downloaded image is empty')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_OFFICE_IMAGE_BYTES) {
          await reader.cancel()
          throw new Error('The image is too large to embed')
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    if (!length) throw new Error('The downloaded image is empty')
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return officeImageDataUrl(bytes, mime)
  }
  throw new Error('The image has too many redirects')
}
