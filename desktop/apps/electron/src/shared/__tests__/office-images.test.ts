import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { downloadOfficeImage, MAX_OFFICE_IMAGE_BYTES } from '../office-images'

let originalFetch: typeof fetch
beforeEach(() => { originalFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = originalFetch })

it('follows HTTPS redirects without credentials and embeds the final image bytes', async () => {
  const request = mock(async (url: string, init?: RequestInit) => {
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    return url.endsWith('/first')
      ? new Response(null, { status: 302, headers: { location: '/image' } })
      : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png; charset=binary' } })
  })
  globalThis.fetch = request as unknown as typeof fetch
  expect(await downloadOfficeImage('https://images.example/first')).toBe('data:image/png;base64,AQID')
  expect(request.mock.calls.map(([url]) => url)).toEqual(['https://images.example/first', 'https://images.example/image'])
})

it('rejects HTTP, local file URLs and redirected downgrades before fetching them', async () => {
  const request = mock(async () => new Response(null, { status: 302, headers: { location: 'http://images.example/image' } }))
  globalThis.fetch = request as unknown as typeof fetch
  for (const url of ['http://images.example/image', 'file:///image.png', 'https://user:password@images.example/image']) {
    await expect(downloadOfficeImage(url)).rejects.toThrow('must use HTTPS')
  }
  expect(request).not.toHaveBeenCalled()
  await expect(downloadOfficeImage('https://images.example/image')).rejects.toThrow('must use HTTPS')
  expect(request).toHaveBeenCalledTimes(1)
})

it('rejects failed requests and responses that are not supported image media', async () => {
  for (const response of [
    new Response(null, { status: 404 }),
    new Response('<html>Login required</html>', { headers: { 'content-type': 'text/html' } }),
    new Response(null, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_OFFICE_IMAGE_BYTES + 1) } }),
  ]) {
    globalThis.fetch = mock(async () => response) as unknown as typeof fetch
    await expect(downloadOfficeImage('https://images.example/image')).rejects.toThrow()
  }
})

it('stops an oversized streaming response even when content-length is absent', async () => {
  const cancel = mock(() => undefined)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_OFFICE_IMAGE_BYTES + 1)) }, cancel })
  globalThis.fetch = mock(async () => new Response(stream, { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch
  await expect(downloadOfficeImage('https://images.example/image')).rejects.toThrow('too large')
  expect(cancel).toHaveBeenCalledTimes(1)
})
