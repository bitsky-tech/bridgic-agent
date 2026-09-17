import { afterAll, afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { Workbook } from 'exceljs'
import { LocaleType } from '@univerjs/core'
import JSZip from 'jszip'

GlobalRegistrator.register()
const { prepareOfficeImage } = await import('../office/officeImage')
const { createWordWorkspace, createWordDomainStore, isWordDocumentDirty, reduceWordCommand } = await import('../wordDomain')
const { exportWordDocx } = await import('../wordDocxExport')
const { importDocxToHtml } = await import('../wordDocxImport')
const { importXlsx, exportXlsx } = await import('../excelWorkbook')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const WEBP = 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA='
const BMP = 'Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA=='
const pngSource = `data:image/png;base64,${PNG}`
const webpSource = `data:image/webp;base64,${WEBP}`
const globals = ['fetch', 'createImageBitmap', 'OffscreenCanvas'] as const
let original: Array<PropertyDescriptor | undefined>
const decoded: string[] = []
const closed = mock(() => undefined)

beforeEach(() => {
  original = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))
  decoded.length = 0
  closed.mockClear()
  // Bun has no raster decoder; native Electron coverage verifies the actual pixel conversion.
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async (blob: Blob) => {
    decoded.push(blob.type)
    return { width: 1, height: 1, close: closed }
  } })
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: class {
    getContext() { return { drawImage() {} } }
    async convertToBlob() { return new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }) }
  } })
})
afterEach(() => {
  globals.forEach((key, index) => {
    const descriptor = original[index]
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  })
})
afterAll(() => GlobalRegistrator.unregister())

it('converts BMP and WebP to PNG while retaining supported image payloads', async () => {
  for (const [mime, payload] of [['bmp', BMP], ['webp', WEBP]]) {
    expect(await prepareOfficeImage(`data:image/${mime};base64,${payload}`, 'word')).toEqual({ extension: 'png', base64: PNG, dataUrl: pngSource })
  }
  expect(decoded).toEqual(['image/bmp', 'image/webp'])
  expect(closed).toHaveBeenCalledTimes(2)
  for (const mime of ['png', 'jpeg', 'gif'] as const) {
    expect((await prepareOfficeImage(`data:image/${mime};base64,${PNG}`, 'word')).extension).toBe(mime)
  }
  expect(decoded).toHaveLength(2)
})

async function workbookWithImage(source: string) {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheet('Images')
  sheet.getCell('A1').value = 'Keep the image'
  sheet.addImage(workbook.addImage({ extension: 'png', base64: PNG }), { tl: { col: 1, row: 1 }, br: { col: 2, row: 2 } } as never)
  const snapshot = await importXlsx(new Uint8Array(await workbook.xlsx.writeBuffer()), LocaleType.EN_US)
  const resource = snapshot.resources!.find((item) => item.name === 'SHEET_DRAWING_PLUGIN')!
  const drawings = JSON.parse(resource.data)
  const drawing = Object.values(drawings[snapshot.sheetOrder[0]!])[0] as { source: string }
  drawing.source = source
  resource.data = JSON.stringify(drawings)
  return snapshot
}

it('includes an inserted BMP in the saved XLSX and reopens it as an embedded PNG', async () => {
  const source = `data:image/bmp;base64,${BMP}`
  const snapshot = await workbookWithImage(source)
  const bytes = await exportXlsx(snapshot, { allowLossy: true })
  const file = new Workbook()
  await file.xlsx.load(bytes.slice().buffer)
  expect(file.worksheets[0]!.getImages()).toHaveLength(1)
  expect(file.getImage(Number(file.worksheets[0]!.getImages()[0]!.imageId)).extension).toBe('png')
  const reopened = await importXlsx(bytes, LocaleType.EN_US)
  expect(reopened.resources!.find((item) => item.name === 'SHEET_DRAWING_PLUGIN')!.data).toContain(pngSource)
  expect(snapshot.resources!.find((item) => item.name === 'SHEET_DRAWING_PLUGIN')!.data).toContain(source)
})

it('does not silently drop an unsupported image even when simplifying imported XLSX objects', async () => {
  const snapshot = await workbookWithImage('data:image/tiff;base64,AAAA')
  await expect(exportXlsx(snapshot, { allowLossy: true })).rejects.toThrow('Use an embedded')
})

it('converts WebP before Word accepts the edit and preserves the image through DOCX reopening', async () => {
  const writes: Uint8Array[] = []
  const store = createWordDomainStore(createWordWorkspace('webp', 'Report'), {
    defaultTitle: 'Report', autoSave: true,
    saveDocument: async (document) => {
      writes.push(await exportWordDocx(document))
      return { ok: true, fileName: 'Report.docx', source: { path: '/Report.docx', mtimeMs: 1 } }
    },
  })
  try {
    expect((await store.dispatch({ type: 'document.update', html: `<p><img src="${webpSource}"/></p>` })).ok).toBe(true)
    expect(isWordDocumentDirty(store.getSnapshot().documents[0]!)).toBe(false)
    expect(JSON.stringify(store.getSnapshot())).toContain(pngSource)
    expect(JSON.stringify(store.getSnapshot())).not.toContain('image/webp')
    const zip = await JSZip.loadAsync(writes[0]!)
    expect(await zip.file('word/media/image1.png')!.async('base64')).toBe(PNG)
    expect(JSON.stringify((await importDocxToHtml(writes[0]!)).document)).toContain(pngSource)
    expect((await store.dispatch({ type: 'document.append', text: 'A later edit' })).ok).toBe(true)
    expect(writes).toHaveLength(2)
    expect(decoded).toEqual(['image/webp'])
  } finally { store.dispose() }
})

it('embeds a Word HTTPS image once so later edits and reopened files work offline', async () => {
  const fetchImage = mock(async () => new Response(Buffer.from(PNG, 'base64'), { headers: { 'content-type': 'image/png' } }))
  globalThis.fetch = fetchImage as unknown as typeof fetch
  const store = createWordDomainStore(createWordWorkspace('remote', 'Report'), { defaultTitle: 'Report' })
  try {
    expect((await store.dispatch({ type: 'document.update', html: '<p><img src="https://example.com/image.png"/></p>' })).ok).toBe(true)
    const current = store.getSnapshot().documents[0]!
    expect(JSON.stringify(current.snapshot)).toContain(pngSource)
    expect(fetchImage).toHaveBeenCalledTimes(1)
    fetchImage.mockRejectedValue(new Error('offline'))
    const reopened = await importDocxToHtml(await exportWordDocx(current))
    expect(JSON.stringify(reopened.document)).toContain(pngSource)
    expect(fetchImage).toHaveBeenCalledTimes(1)
  } finally { store.dispose() }
})

it('rejects unavailable remote images before modifying Word HTML, snapshots or the native editor', async () => {
  globalThis.fetch = mock(async () => new Response('Unavailable', { status: 404 })) as unknown as typeof fetch
  const store = createWordDomainStore(createWordWorkspace('failed-image', 'Report'), { defaultTitle: 'Report' })
  const state = store.getSnapshot()
  const handler = mock(async () => true)
  store.registerEditorCommandHandler(state.activeDocumentId, handler)
  try {
    const html = '<p><img src="https://example.com/missing.png"/></p>'
    const old = reduceWordCommand(state, { type: 'document.update', html }, 'Report')
    if (!old.ok) throw new Error('Expected a legacy snapshot containing a remote image')
    for (const command of [
      { type: 'document.update', html },
      { type: 'document.update', snapshot: old.state.documents[0]!.snapshot },
      { type: 'document.create', html },
      { type: 'editor.insert', kind: 'html', html },
      { type: 'editor.insert', kind: 'image', src: 'https://example.com/missing.png' },
      { type: 'document.headerFooter.update', settings: { headerHtml: html } },
    ]) {
      expect((await store.dispatch(command)).ok).toBe(false)
      expect(store.getSnapshot()).toBe(state)
    }
    expect(handler).not.toHaveBeenCalled()
    expect((await store.dispatch({ type: 'document.append', text: 'Still editable' })).ok).toBe(true)
    await expect(exportWordDocx(store.getSnapshot().documents[0]!)).resolves.toBeInstanceOf(Uint8Array)
  } finally { store.dispose() }
})

it('rescues existing Word WebP snapshots at export without mutating the live snapshot', async () => {
  const store = createWordDomainStore(createWordWorkspace('recovered-image', 'Report'), { defaultTitle: 'Report' })
  try {
    await store.dispatch({ type: 'document.update', html: `<p><img src="${pngSource}"/></p>` })
    const current = structuredClone(store.getSnapshot().documents[0]!)
    const drawing = Object.values(current.snapshot.drawings!)[0]! as unknown as { source: string }
    drawing.source = webpSource
    const reopened = await importDocxToHtml(await exportWordDocx(current))
    expect(JSON.stringify(reopened.document)).toContain(pngSource)
    expect(drawing.source).toBe(webpSource)
  } finally { store.dispose() }
})
