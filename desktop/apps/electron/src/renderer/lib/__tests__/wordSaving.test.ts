import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import JSZip from 'jszip'
import type { OfficeFileSaveResult } from '../../../shared/office-files'

GlobalRegistrator.register()
const { createWordWorkspace, createEmptyWordWorkspace, createWordDomainStore, isWordDocumentDirty } = await import('../wordDomain')
const { exportWordDocx } = await import('../wordDocxExport')
const { importDocxToHtml } = await import('../wordDocxImport')
afterAll(() => GlobalRegistrator.unregister())
const saved: OfficeFileSaveResult = { ok: true, source: { path: '/report.docx', mtimeMs: 42 }, fileName: 'report.docx' }

describe('Word explicit saving', () => {
  it('opens Save as when closing an edited source that requires protection', async () => {
    const save = mock(async (): Promise<OfficeFileSaveResult> => ({ ok: true, source: { path: '/Copy.docx', mtimeMs: 2 }, fileName: 'Copy.docx' }))
    const store = createWordDomainStore(createEmptyWordWorkspace('protected-close'), { defaultTitle: 'Report', confirmClose: async () => 'save', saveDocument: save })
    await store.dispatch({ type: 'document.open', title: 'Original.docx', html: '<p>Original</p>', sourcePath: '/Original.docx', sourceMtimeMs: 1, sourceProtected: true })
    await store.dispatch({ type: 'document.append', text: 'Edited' })
    expect((await store.closeDocumentTab(store.getSnapshot().activeDocumentId)).ok).toBe(true)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ sourceProtected: true }), true, undefined)
    expect(store.getSnapshot().documents).toHaveLength(0)
    store.dispose()
  })

  it('reopens and saves page settings, headers, footers and native formatting through two file cycles', async () => {
    const store = createWordDomainStore(createWordWorkspace('round-trip', 'Report'), { defaultTitle: 'Report' })
    await store.dispatch({ type: 'document.update', html: '<p><span style="font-size:22px;color:#123456">Report</span></p>' })
    await store.dispatch({ type: 'document.page.update', page: { orientation: 'landscape', margins: 'narrow' } })
    await store.dispatch({ type: 'document.headerFooter.update', settings: { headerHtml: '<p>Confidential</p>', footerHtml: '<p>Finance</p>', showPageNumbers: true } })
    const original = store.getSnapshot().documents[0]!
    let bytes = await exportWordDocx(original)
    for (let cycle = 0; cycle < 2; cycle++) {
      const imported = await importDocxToHtml(bytes)
      expect(imported.sourceProtected).toBe(false)
      const reopened = createWordDomainStore(createEmptyWordWorkspace(`round-trip-${cycle}`), { defaultTitle: 'Report' })
      expect((await reopened.dispatch({ type: 'document.open', title: 'Report.docx', sourcePath: '/Report.docx', sourceMtimeMs: 1, ...imported })).ok).toBe(true)
      const document = reopened.getSnapshot().documents[0]!
      expect(document.page).toEqual(original.page)
      expect(document.headerFooter).toEqual(original.headerFooter)
      expect(document.snapshot.body!.textRuns).toEqual(original.snapshot.body!.textRuns)
      await reopened.dispatch({ type: 'document.append', text: `Correction ${cycle}` })
      bytes = await exportWordDocx(reopened.getSnapshot().documents[0]!)
      const zip = await JSZip.loadAsync(bytes)
      expect(await zip.file('word/header.xml')!.async('string')).toContain('Confidential')
      expect(await zip.file('word/footer.xml')!.async('string')).toContain('Finance')
      expect(await zip.file('word/document.xml')!.async('string')).toContain('w:orient="landscape"')
      reopened.dispose()
    }
    store.dispose()
  })

  it('reads external edits instead of a stale embedded snapshot and protects the source', async () => {
    const store = createWordDomainStore(createWordWorkspace('external-edit', 'Report'), { defaultTitle: 'Report' })
    await store.dispatch({ type: 'document.append', text: 'Original text' })
    const zip = await JSZip.loadAsync(await exportWordDocx(store.getSnapshot().documents[0]!))
    const xml = await zip.file('word/document.xml')!.async('string')
    zip.file('word/document.xml', xml.replace('Original text', 'External correction'))
    const imported = await importDocxToHtml(await zip.generateAsync({ type: 'uint8array' }))
    expect(imported.html).toContain('External correction')
    expect(imported.document).toBeUndefined()
    expect(imported.sourceProtected).toBe(true)
    store.dispose()
  })

  it('exports editable OOXML with text, formatting, tables and embedded images', async () => {
    const store = createWordDomainStore(createWordWorkspace('word-save', 'Report'), { defaultTitle: 'Report' })
    await store.dispatch({ type: 'document.update', html: '<h1>Report</h1><p><b>Bold</b> and <i>italic</i></p><table><tr><td>First</td><td>Second</td></tr></table><p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6T4cAAAAASUVORK5CYII=" /></p>' })
    const bytes = await exportWordDocx(store.getSnapshot().documents[0]!)
    const zip = await JSZip.loadAsync(bytes)
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<w:tbl>')
    const imported = await importDocxToHtml(bytes)
    expect(imported.html).toContain('<strong>Bold</strong>')
    expect(imported.html).toContain('<em>italic</em>')
    expect(imported.html).toContain('First')
    expect(imported.html).toContain('<img')
    const reopened = createWordDomainStore(createEmptyWordWorkspace('image-reopen'), { defaultTitle: 'Report' })
    await reopened.dispatch({ type: 'document.open', title: 'Report.docx', sourcePath: '/Report.docx', sourceMtimeMs: 1, ...imported })
    const restored = reopened.getSnapshot().documents[0]!
    expect(Object.values(restored.snapshot.drawings!)).toHaveLength(1)
    expect(Object.values(restored.snapshot.drawings!)[0]).toMatchObject({ unitId: restored.id, subUnitId: restored.id })
    reopened.dispose()
    store.dispose()
  })
  it('keeps edits as drafts until save, and retains a newer edit during the file write', async () => {
    let finish!: (value: OfficeFileSaveResult) => void
    const save = mock(() => new Promise<OfficeFileSaveResult>((resolve) => { finish = resolve }))
    const store = createWordDomainStore(createWordWorkspace('word-save', 'Report'), { defaultTitle: 'Report', saveDocument: save })
    await store.dispatch({ type: 'document.append', text: 'Before save' })
    expect(save).not.toHaveBeenCalled()
    const writing = store.dispatch({ type: 'document.save' })
    await Promise.resolve()
    const document = store.getSnapshot().documents[0]!
    store.commitEditorSnapshot(document.id, { ...document.snapshot, body: { dataStream: 'Newer typing\r\n' } })
    finish(saved)
    expect(await writing).toMatchObject({ ok: false, error: { code: 'save_incomplete' } })
    expect(isWordDocumentDirty(store.getSnapshot().documents[0]!)).toBe(true)
    expect(store.getSnapshot().documents[0]!.snapshot.body!.dataStream).toContain('Newer typing')
    store.dispose()
  })
  it('preserves merged cells, ordered lists, headings, landscape pages and page-number fields', async () => {
    const store = createWordDomainStore(createWordWorkspace('word-layout', 'Layout'), { defaultTitle: 'Layout' })
    await store.dispatch({ type: 'document.update', html: '<h1>Heading</h1><ol><li>One</li><li>Two</li></ol><table><tr><td colspan="2">Merged</td></tr><tr><td>A</td><td>B</td></tr></table>' })
    await store.dispatch({ type: 'document.page.update', page: { orientation: 'landscape' } })
    await store.dispatch({ type: 'document.headerFooter.update', settings: { headerHtml: 'Header', showPageNumbers: true } })
    const bytes = await exportWordDocx(store.getSnapshot().documents[0]!)
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:gridSpan w:val="2"/>')
    expect(xml).toContain('<w:pgSz w:w="16860" w:h="11910" w:orient="landscape"/>')
    expect(await zip.file('word/footer.xml')!.async('string')).toContain('w:instr="PAGE"')
    const imported = await importDocxToHtml(bytes)
    expect(imported.html).toContain('<h1>Heading</h1>')
    expect(imported.html).toContain('<ol>')
    expect(imported.html).toContain('colspan="2"')
    store.dispose()
  })
  it('keeps a dirty tab open on cancel or a canceled save, and closes only after discard', async () => {
    const confirm = mock(async () => 'cancel' as 'save' | 'discard' | 'cancel')
    const save = mock(async (): Promise<OfficeFileSaveResult> => ({ ok: false, reason: 'canceled' }))
    const store = createWordDomainStore(createWordWorkspace('word-save', 'Report'), { defaultTitle: 'Report', confirmClose: confirm, saveDocument: save })
    const id = store.getSnapshot().activeDocumentId
    await store.closeDocumentTab(id)
    expect(store.getSnapshot().documents).toHaveLength(1)
    confirm.mockResolvedValue('save')
    await store.closeDocumentTab(id)
    expect(store.getSnapshot().documents).toHaveLength(1)
    confirm.mockResolvedValue('discard')
    expect(await store.closeDocumentTab(id)).toMatchObject({ ok: true, value: { closeSurface: true } })
    expect(store.getSnapshot().documents).toHaveLength(0)
    store.dispose()
  })
})


it('automatically saves Word creation and edits, and preserves content when closing cannot save', async () => {
  const save = mock(async (): Promise<OfficeFileSaveResult> => saved)
  const confirm = mock(async () => 'discard' as const)
  const store = createWordDomainStore(createEmptyWordWorkspace('automatic-word'), { defaultTitle: 'Report', autoSave: true, saveDocument: save, confirmClose: confirm })
  expect((await store.dispatch({ type: 'document.create' })).ok).toBe(true)
  expect(save).toHaveBeenCalledTimes(1)
  expect(store.getSnapshot().documents[0]!.sourcePath).toBe('/report.docx')
  expect((await store.dispatch({ type: 'document.append', text: 'Saved edit' })).ok).toBe(true)
  expect(save).toHaveBeenCalledTimes(2)
  expect(isWordDocumentDirty(store.getSnapshot().documents[0]!)).toBe(false)
  save.mockRejectedValue(new Error('disk full'))
  expect((await store.dispatch({ type: 'document.append', text: 'Retained edit' })).ok).toBe(false)
  expect((await store.closeDocumentTab(store.getSnapshot().activeDocumentId)).ok).toBe(false)
  expect(store.getSnapshot().documents).toHaveLength(1)
  expect(store.getSnapshot().documents[0]!.snapshot.body!.dataStream).toContain('Retained edit')
  expect(confirm).not.toHaveBeenCalled()
  save.mockResolvedValue(saved)
  expect((await store.dispatch({ type: 'document.save' })).ok).toBe(true)
  expect(isWordDocumentDirty(store.getSnapshot().documents[0]!)).toBe(false)
  store.dispose()
})

it('rejects a parsed Word replacement when native input changes during the final flush', async () => {
  const store = createWordDomainStore(createEmptyWordWorkspace('reopen-native'), { defaultTitle: 'Report', autoSave: true, saveDocument: async () => saved })
  await store.dispatch({ type: 'document.open', title: 'Report.docx', html: '<p>Original</p>', sourcePath: '/report.docx', sourceMtimeMs: 1 })
  const document = store.getSnapshot().documents[0]!
  const revision = store.api.workspace.getSnapshot().documents[0]!.revision
  let typed = false
  const detach = store.registerEditorCommandHandler(document.id, async () => true, async () => {
    if (typed) return
    typed = true
    store.commitEditorSnapshot(document.id, { ...document.snapshot, body: { dataStream: 'Pending native input\r\n' } })
  })
  try {
    expect(await store.dispatch({ type: 'document.open', title: 'Report.docx', html: '<p>Stale parsed text</p>', sourcePath: '/report.docx', sourceMtimeMs: 2, documentId: document.id, expectedDocumentRevision: revision })).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
    expect(store.getSnapshot().documents[0]!.snapshot.body!.dataStream).toContain('Pending native input')
    expect(isWordDocumentDirty(store.getSnapshot().documents[0]!)).toBe(true)
    expect((await store.dispatch({ type: 'document.save' })).ok).toBe(true)
    expect(isWordDocumentDirty(store.getSnapshot().documents[0]!)).toBe(false)
  } finally { detach(); store.dispose() }
})

it('refreshes an unchanged Word file with a guarded import without coupling it to other tabs', async () => {
  const store = createWordDomainStore(createEmptyWordWorkspace('reopen-clean'), { defaultTitle: 'Report' })
  try {
    await store.dispatch({ type: 'document.open', title: 'Report.docx', html: '<p>Original</p>', sourcePath: '/report.docx', sourceMtimeMs: 1 })
    const document = store.getSnapshot().documents[0]!
    const revision = store.api.workspace.getSnapshot().documents[0]!.revision
    await store.dispatch({ type: 'document.create', title: 'Unrelated' })
    await store.dispatch({ type: 'document.append', text: 'Another document edit' })
    expect((await store.dispatch({ type: 'document.open', title: 'Report.docx', html: '<p>Refreshed file</p>', sourcePath: '/report.docx', sourceMtimeMs: 2, documentId: document.id, expectedDocumentRevision: revision })).ok).toBe(true)
    expect(store.getSnapshot().documents).toHaveLength(2)
    expect(store.getSnapshot().documents[0]!.snapshot.body!.dataStream).toContain('Refreshed file')
  } finally { store.dispose() }
})
