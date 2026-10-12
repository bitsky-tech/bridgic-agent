import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import JSZip from 'jszip'
import type { OfficeFileSaveResult } from '../../../shared/office-files'

GlobalRegistrator.register()
const { createWordWorkspace, createEmptyWordWorkspace, createWordDomainStore, isWordDocumentDirty } = await import('../wordDomain')
const { exportWordDocx } = await import('../wordDocxExport')
const { importDocxToHtml } = await import('../wordDocxImport')
const { createUniverDocumentSnapshot, createUniverSectionedDocumentSnapshot, htmlToUniverSnapshot } = await import('../wordUniverModel')
afterAll(() => GlobalRegistrator.unregister())
const saved: OfficeFileSaveResult = { ok: true, source: { path: '/report.docx', mtimeMs: 42 }, fileName: 'report.docx' }

describe('Word explicit saving', () => {
  it('exports added and cleared header/footer content from an ordinary imported section after body replacement', async () => {
    const page = { size: 'a4', orientation: 'landscape', margins: 'normal' } as const
    const settings = { headerHtml: '', footerHtml: '', showPageNumbers: false, differentFirstPage: false, pageNumberStart: 6 }
    const native = createUniverDocumentSnapshot('blank-imported-parts', 'Report', page, settings, '<p>Imported body</p>')
    const geometry = {
      pageSize: { width: 1200, height: 700 }, pageOrient: 1,
      marginTop: 41, marginBottom: 43, marginLeft: 47, marginRight: 53, marginHeader: 19, marginFooter: 23,
      useFirstPageHeaderFooter: 0, pageNumberStart: 6,
    }
    Object.assign(native.documentStyle, geometry)
    const source = createWordDomainStore(createEmptyWordWorkspace('blank-imported-parts-source'), { defaultTitle: 'Report' })
    const editing = createWordDomainStore(createEmptyWordWorkspace('blank-imported-parts-editing'), { defaultTitle: 'Report' })
    const reopened = createWordDomainStore(createEmptyWordWorkspace('blank-imported-parts-reopened'), { defaultTitle: 'Report' })
    const openExternal = async (bytes: Uint8Array, store: typeof editing) => {
      const archive = await JSZip.loadAsync(bytes)
      archive.remove('bridgic/editor-model.json')
      const imported = await importDocxToHtml(await archive.generateAsync({ type: 'uint8array' }))
      expect(imported.document).toBeUndefined()
      const { page: importedPage, headerFooter, sections } = imported.layout!
      const snapshot = createUniverSectionedDocumentSnapshot('imported-word', 'Document', importedPage, headerFooter, sections!)
      expect((await store.dispatch({ type: 'document.open', title: 'Report.docx', sourcePath: '/Report.docx', sourceMtimeMs: 1, ...imported, document: {
        snapshot, page: importedPage, headerFooter, footnotes: [], citations: [],
      } })).ok).toBe(true)
      return store.getSnapshot().documents[0]!
    }
    const exportCurrent = async (store: typeof editing, hasParts: boolean) => {
      const document = store.getSnapshot().documents[0]!
      expect(document.snapshot.documentStyle).toMatchObject(geometry)
      const section = document.snapshot.body!.sectionBreaks!.find((item) => item.startIndex === document.snapshot.body!.dataStream.length - 1)!
      expect(section).toMatchObject(geometry)
      const bytes = await exportWordDocx(document)
      const archive = await JSZip.loadAsync(bytes)
      const xml = await archive.file('word/document.xml')!.async('string')
      expect(xml).toContain('w:w="18000" w:h="10500" w:orient="landscape"')
      expect(xml).toContain('w:top="615" w:bottom="645" w:left="705" w:right="795" w:header="285" w:footer="345"')
      for (const kind of ['header', 'footer']) {
        expect(xml.includes(`<w:${kind}Reference w:type="default"`)).toBe(hasParts)
        if (hasParts) expect(await archive.file(`word/${kind}.xml`)!.async('string')).toContain(`Added imported ${kind}`)
        else expect(archive.file(`word/${kind}.xml`)).toBeNull()
      }
      return bytes
    }
    try {
      expect((await source.dispatch({ type: 'document.create', snapshot: native })).ok).toBe(true)
      const imported = await openExternal(await exportWordDocx(source.getSnapshot().documents[0]!), editing)
      const initialSection = imported.snapshot.body!.sectionBreaks!.find((item) => item.startIndex === imported.snapshot.body!.dataStream.length - 1)!
      // An external headerless section explicitly overrides the global default ids.
      expect(initialSection).toMatchObject({ defaultHeaderId: '', defaultFooterId: '', firstPageHeaderId: '', firstPageFooterId: '', evenPageHeaderId: '', evenPageFooterId: '' })
      expect((await editing.dispatch({ type: 'document.headerFooter.update', settings: { headerHtml: '<p>Added imported header</p>', footerHtml: '<p>Added imported footer</p>' } })).ok).toBe(true)
      await exportCurrent(editing, true)
      expect((await editing.dispatch({ type: 'document.update', html: '<p>Replacement body</p>' })).ok).toBe(true)
      const restored = await openExternal(await exportCurrent(editing, true), reopened)
      expect(restored.snapshot.body!.dataStream).toContain('Replacement body')
      expect(restored.headerFooter.headerHtml).toContain('Added imported header')
      expect(restored.headerFooter.footerHtml).toContain('Added imported footer')
      const restoredSection = restored.snapshot.body!.sectionBreaks!.find((item) => item.startIndex === restored.snapshot.body!.dataStream.length - 1)!
      expect(restoredSection.defaultHeaderId).toBe(restored.snapshot.documentStyle.defaultHeaderId)
      expect(restoredSection.defaultFooterId).toBe(restored.snapshot.documentStyle.defaultFooterId)
      expect((await reopened.dispatch({ type: 'document.headerFooter.update', settings: { headerHtml: '', footerHtml: '' } })).ok).toBe(true)
      expect((await reopened.dispatch({ type: 'document.update', html: '<p>Body after clearing parts</p>' })).ok).toBe(true)
      const cleared = await JSZip.loadAsync(await exportCurrent(reopened, false))
      cleared.remove('bridgic/editor-model.json')
      const clearedImport = await importDocxToHtml(await cleared.generateAsync({ type: 'uint8array' }))
      expect(clearedImport.html).toContain('Body after clearing parts')
      expect(clearedImport.layout!.headerFooter).toMatchObject({ headerHtml: '', footerHtml: '' })
      expect(clearedImport.layout!.sections![0]!.parts).toHaveLength(0)
    } finally { source.dispose(); editing.dispose(); reopened.dispose() }
  })

  it('preserves ordinary imported native layout and rich parts when HTML replaces the body before saving', async () => {
    const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6T4cAAAAASUVORK5CYII='
    const page = { size: 'a4', orientation: 'landscape', margins: 'normal' } as const
    const headerFooter = {
      headerHtml: '', footerHtml: '', showPageNumbers: false, differentFirstPage: true, pageNumberStart: 6,
    }
    const native = createUniverSectionedDocumentSnapshot('external-rich-layout', 'Report', page, headerFooter, [{
      html: `<p>Original body</p><p><img src="${logo}" width="30" height="15" /></p><table><tr><td>Original body cell</td></tr></table><ol><li>Original body list</li></ol>`,
      style: {
        pageSize: { width: 1200, height: 700 }, pageOrient: 1,
        marginTop: 41, marginBottom: 43, marginLeft: 47, marginRight: 53, marginHeader: 19, marginFooter: 23,
        useFirstPageHeaderFooter: 1, pageNumberStart: 6, pageNumberFormat: 'upperRoman', sectionType: 4,
        defaultHeaderId: 'external-header', defaultFooterId: 'external-footer',
      },
      parts: [
        { kind: 'header', variant: 'default', id: 'external-header', html: `<p><img src="${logo}" width="80" height="20" /><strong>Native brand</strong></p><table><tr><td>Native header cell</td></tr></table><ol><li>Native header list</li></ol><p><a href="https://example.com/header">Header link</a></p>` },
        { kind: 'footer', variant: 'default', id: 'external-footer', html: `<p><img src="${logo}" width="40" height="10" /><em>Native footer</em></p><ul><li>Native footer list</li></ul>` },
      ],
    }])
    const source = createWordDomainStore(createEmptyWordWorkspace('external-rich-layout-source'), { defaultTitle: 'Report' })
    const editing = createWordDomainStore(createEmptyWordWorkspace('external-rich-layout-editing'), { defaultTitle: 'Report' })
    const reopened = createWordDomainStore(createEmptyWordWorkspace('external-rich-layout-reopened'), { defaultTitle: 'Report' })
    const openExternal = async (bytes: Uint8Array, store: typeof editing) => {
      const archive = await JSZip.loadAsync(bytes)
      archive.remove('bridgic/editor-model.json')
      const imported = await importDocxToHtml(await archive.generateAsync({ type: 'uint8array' }))
      expect(imported.document).toBeUndefined()
      expect(imported.layout!.sections).toHaveLength(1)
      // Materialize the same native sectioned snapshot as the ordinary wordImport.ts path.
      const { page: importedPage, headerFooter: importedParts, sections } = imported.layout!
      const snapshot = createUniverSectionedDocumentSnapshot('imported-word', 'Document', importedPage, importedParts, sections!)
      snapshot.documentStyle.evenAndOddHeaders = imported.layout!.evenAndOddHeaders ? 1 : 0
      expect((await store.dispatch({ type: 'document.open', title: 'Report.docx', sourcePath: '/Report.docx', sourceMtimeMs: 1, ...imported, document: {
        snapshot, page: importedPage, headerFooter: importedParts, footnotes: [], citations: [],
      } })).ok).toBe(true)
      return store.getSnapshot().documents[0]!
    }
    try {
      expect((await source.dispatch({ type: 'document.create', snapshot: native })).ok).toBe(true)
      const imported = await openExternal(await exportWordDocx(source.getSnapshot().documents[0]!), editing)
      const before = structuredClone(imported.snapshot)
      const geometry = {
        pageSize: { width: 1200, height: 700 }, pageOrient: 1,
        marginTop: 41, marginBottom: 43, marginLeft: 47, marginRight: 53, marginHeader: 19, marginFooter: 23,
        useFirstPageHeaderFooter: 1, pageNumberStart: 6,
      }
      expect(before.documentStyle).toMatchObject(geometry)
      const initialSection = before.body!.sectionBreaks!.find((section) => section.startIndex === before.body!.dataStream.length - 1)!
      expect(initialSection).toMatchObject({ ...geometry, pageNumberFormat: 'upperRoman', sectionType: 4 })
      const segments = [...Object.values(before.headers!), ...Object.values(before.footers!)].map((part) => part.body)
      const segmentDrawings = segments.flatMap((body) => body.customBlocks?.map((block) => block.blockId) ?? [])
      const segmentTables = segments.flatMap((body) => body.tables?.map((table) => table.tableId) ?? [])
      const segmentLists = segments.flatMap((body) => body.paragraphs?.flatMap(({ bullet }) => bullet ? [bullet.listId, bullet.listType] : []) ?? [])
      const segmentRanges = segments.flatMap((body) => body.customRanges?.map((range) => range.rangeId) ?? [])
      expect(segmentDrawings).toHaveLength(2)
      expect(segmentTables).toHaveLength(1)
      expect(segmentLists.length).toBeGreaterThan(0)
      expect(segmentRanges).toHaveLength(1)
      expect((await editing.dispatch({ type: 'document.update', html: `<h1>Replacement body</h1><table><tr><td>New body cell</td></tr></table><p><img src="${logo}" width="90" height="45" /></p><ol><li>New body number<ul><li>New body bullet</li></ul></li></ol><p><a href="https://example.com/body">New body link</a></p>` })).ok).toBe(true)
      const updated = editing.getSnapshot().documents[0]!
      expect(updated.snapshot.documentStyle).toEqual(before.documentStyle)
      expect(updated.snapshot.headers).toEqual(before.headers)
      expect(updated.snapshot.footers).toEqual(before.footers)
      const body = updated.snapshot.body!
      expect(body.dataStream).toContain('Replacement body')
      expect(body.dataStream).not.toContain('Original body')
      const finalSection = body.sectionBreaks!.find((section) => section.startIndex === body.dataStream.length - 1)!
      expect(finalSection).toEqual({ ...initialSection, startIndex: body.dataStream.length - 1 })
      for (const id of segmentDrawings) expect(updated.snapshot.drawings![id]).toEqual(before.drawings![id])
      for (const id of segmentTables) expect(updated.snapshot.tableSource![id]).toEqual(before.tableSource![id])
      for (const id of segmentLists) if (before.lists![id]) expect(updated.snapshot.lists![id]).toEqual(before.lists![id])
      expect(body.customBlocks).toHaveLength(1)
      for (const block of body.customBlocks!) {
        expect(segmentDrawings).not.toContain(block.blockId)
        expect(updated.snapshot.drawings![block.blockId]).toMatchObject({ drawingId: block.blockId, unitId: updated.id, subUnitId: updated.id, docTransform: { size: { width: 90, height: 45 } } })
      }
      expect(body.tables).toHaveLength(1)
      for (const table of body.tables!) {
        expect(segmentTables).not.toContain(table.tableId)
        expect(updated.snapshot.tableSource![table.tableId]).toMatchObject({ tableId: table.tableId })
      }
      const bullets = body.paragraphs!.flatMap(({ bullet }) => bullet ? [bullet] : [])
      expect(bullets).toHaveLength(2)
      for (const bullet of bullets) {
        expect(segmentLists).not.toContain(bullet.listId)
        expect(segmentLists).not.toContain(bullet.listType)
        expect(updated.snapshot.lists![bullet.listType]).toBeDefined()
      }
      expect(new Set(bullets.map((bullet) => bullet.listId)).size).toBe(2)
      expect(body.customRanges).toHaveLength(1)
      expect(segmentRanges).not.toContain(body.customRanges![0]!.rangeId)
      expect(body.customRanges![0]!.properties?.url).toBe('https://example.com/body')
      const bytes = await exportWordDocx(updated)
      const archive = await JSZip.loadAsync(bytes)
      const xml = await archive.file('word/document.xml')!.async('string')
      expect(xml).toContain('w:w="18000" w:h="10500" w:orient="landscape"')
      expect(xml).toContain('w:top="615" w:bottom="645" w:left="705" w:right="795" w:header="285" w:footer="345"')
      expect(xml).toContain('<w:pgNumType w:start="6" w:fmt="upperRoman"/>')
      expect(xml).toContain('New body cell')
      expect(xml).not.toContain('Original body')
      const numbering = new DOMParser().parseFromString(await archive.file('word/numbering.xml')!.async('string'), 'text/xml')
      const bodyListIds = Array.from(xml.matchAll(/<w:numId w:val="(\d+)"\/>/g), (match) => match[1]!)
      expect(new Set(bodyListIds).size).toBe(2)
      const bodyListFormats = bodyListIds.map((id) => {
        const definition = Array.from(numbering.getElementsByTagName('w:abstractNum')).find((node) => node.getAttribute('w:abstractNumId') === id)!
        return definition.getElementsByTagName('w:numFmt')[0]!.getAttribute('w:val')
      })
      expect(bodyListFormats.sort()).toEqual(['bullet', 'decimal'])
      expect(await archive.file('word/header.xml')!.async('string')).toContain('Native header cell')
      const final = await openExternal(bytes, reopened)
      expect(final.snapshot.documentStyle).toMatchObject(geometry)
      expect(final.snapshot.body!.dataStream).toContain('Replacement body')
      expect(final.snapshot.body!.dataStream).not.toContain('Original body')
      expect(final.snapshot.body!.tables).toHaveLength(1)
      expect(final.snapshot.body!.customBlocks).toHaveLength(1)
      expect(final.snapshot.body!.paragraphs!.filter((paragraph) => paragraph.bullet)).toHaveLength(2)
      expect(final.snapshot.body!.customRanges![0]!.properties?.url).toBe('https://example.com/body')
      expect(final.snapshot.body!.sectionBreaks!.find((section) => section.startIndex === final.snapshot.body!.dataStream.length - 1)).toMatchObject({ ...geometry, pageNumberFormat: 'upperRoman', sectionType: 4 })
      const header = final.snapshot.headers![final.snapshot.documentStyle.defaultHeaderId!]!.body
      const footer = final.snapshot.footers![final.snapshot.documentStyle.defaultFooterId!]!.body
      expect(header.dataStream).toContain('Native header cell')
      expect(header.tables).toHaveLength(1)
      expect(header.customBlocks).toHaveLength(1)
      expect(header.paragraphs!.filter((paragraph) => paragraph.bullet)).toHaveLength(1)
      expect(header.customRanges![0]!.properties?.url).toBe('https://example.com/header')
      expect(final.snapshot.drawings![header.customBlocks![0]!.blockId]!.docTransform.size).toEqual({ width: 80, height: 20 })
      expect(footer.dataStream).toContain('Native footer')
      expect(footer.customBlocks).toHaveLength(1)
      expect(footer.paragraphs!.filter((paragraph) => paragraph.bullet)).toHaveLength(1)
      expect(final.snapshot.drawings![footer.customBlocks![0]!.blockId]!.docTransform.size).toEqual({ width: 40, height: 10 })
    } finally { source.dispose(); editing.dispose(); reopened.dispose() }
  })

  it('preserves custom native geometry and removed segments through DOCX reopen and save', async () => {
    const initial = createWordDomainStore(createWordWorkspace('native-layout-source', 'Report'), { defaultTitle: 'Report' })
    const reopened = createWordDomainStore(createEmptyWordWorkspace('native-layout-reopened'), { defaultTitle: 'Report' })
    try {
      const native = structuredClone(initial.getSnapshot().documents[0]!.snapshot)
      native.documentStyle = {
        ...native.documentStyle, pageSize: { width: 1200, height: 700 }, pageOrient: 1,
        marginTop: 41, marginBottom: 43, marginLeft: 47, marginRight: 53,
        useFirstPageHeaderFooter: 1, pageNumberStart: 6,
      }
      initial.commitEditorSnapshot(native.id, native)
      const document = initial.getSnapshot().documents[0]!
      let imported = await importDocxToHtml(await exportWordDocx(document))
      for (let cycle = 0; cycle < 2; cycle++) {
        expect(imported.document).toBeDefined()
        // Cached parts must not resurrect a segment deliberately removed from native.
        imported.document!.headerFooter.headerHtml = '<p>Removed header</p>'
        imported.document!.headerFooter.footerHtml = '<p>Removed footer</p>'
        imported.document!.headerFooter.differentFirstPage = false
        imported.document!.headerFooter.pageNumberStart = 1
        expect((await reopened.dispatch({ type: 'document.open', title: 'Report.docx', sourcePath: '/Report.docx', sourceMtimeMs: cycle + 1, ...imported })).ok).toBe(true)
        const current = reopened.getSnapshot().documents[0]!
        expect(current.snapshot.documentStyle).toEqual(native.documentStyle)
        expect(current.headerFooter).toMatchObject({ headerHtml: '', footerHtml: '', differentFirstPage: true, pageNumberStart: 6 })
        expect(current.snapshot.headers).toEqual({})
        expect(current.snapshot.footers).toEqual({})
        const archive = await JSZip.loadAsync(await exportWordDocx(current))
        const xml = await archive.file('word/document.xml')!.async('string')
        expect(xml).toContain('w:w="18000" w:h="10500" w:orient="landscape"')
        expect(xml).toContain('w:top="615" w:bottom="645" w:left="705" w:right="795"')
        expect(xml).toContain('<w:pgNumType w:start="6"/>')
        expect(archive.file('word/header.xml')).toBeNull()
        expect(archive.file('word/footer.xml')).toBeNull()
        imported = await importDocxToHtml(await archive.generateAsync({ type: 'uint8array' }))
      }
    } finally { initial.dispose(); reopened.dispose() }
  })

  it('exports numbering from the canonical snapshot despite stale or missing cached flags', async () => {
    const store = createWordDomainStore(createWordWorkspace('canonical-numbering', 'Report'), { defaultTitle: 'Report' })
    try {
      await store.dispatch({ type: 'document.headerFooter.update', settings: { showPageNumbers: true } })
      const enabled = structuredClone(store.getSnapshot().documents[0]!)
      enabled.headerFooter.showPageNumbers = false
      const enabledZip = await JSZip.loadAsync(await exportWordDocx(enabled))
      expect(await enabledZip.file('word/footer.xml')!.async('string')).toContain('w:instr="PAGE"')
      await store.dispatch({ type: 'document.headerFooter.update', settings: { showPageNumbers: false } })
      const disabled = structuredClone(store.getSnapshot().documents[0]!)
      disabled.headerFooter.showPageNumbers = true
      expect((await JSZip.loadAsync(await exportWordDocx(disabled))).file('word/footer.xml')).toBeNull()
      disabled.snapshot = htmlToUniverSnapshot('<p>Native content without a numbering flag</p>', disabled.id, disabled.title)
      expect((await JSZip.loadAsync(await exportWordDocx(disabled))).file('word/footer.xml')).toBeNull()
    } finally { store.dispose() }
  })

  it('preserves landscape Letter geometry through two external file cycles', async () => {
    const store = createWordDomainStore(createWordWorkspace('landscape-letter', 'Report'), { defaultTitle: 'Report' })
    await store.dispatch({ type: 'document.update', html: '<p>Landscape report</p>' })
    await store.dispatch({ type: 'document.page.update', page: { size: 'letter', orientation: 'landscape' } })
    let current = store.getSnapshot().documents[0]!
    for (let cycle = 0; cycle < 2; cycle++) {
      const zip = await JSZip.loadAsync(await exportWordDocx(current))
      expect(await zip.file('word/document.xml')!.async('string')).toContain('w:w="15840" w:h="12240" w:orient="landscape"')
      zip.remove('bridgic/editor-model.json')
      const imported = await importDocxToHtml(await zip.generateAsync({ type: 'uint8array' }))
      const { page, headerFooter } = imported.layout!
      expect(page).toMatchObject({ size: 'letter', orientation: 'landscape' })
      current = { ...current, page, headerFooter, snapshot: createUniverDocumentSnapshot(current.id, current.title, page, headerFooter, imported.html) }
      expect(current.snapshot.documentStyle.pageSize).toEqual({ width: 816, height: 1056 })
    }
    store.dispose()
  })

  it('retains rich header/footer images and sizes through external import and repeated saving', async () => {
    const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6T4cAAAAASUVORK5CYII='
    const store = createWordDomainStore(createWordWorkspace('rich-header', 'Report'), { defaultTitle: 'Report' })
    await store.dispatch({ type: 'document.update', html: '<p>Report body</p>' })
    await store.dispatch({ type: 'document.headerFooter.update', settings: {
      headerHtml: `<p><img src="${logo}" width="80" height="20" /><b>Brand</b></p>`,
      footerHtml: `<p><img src="${logo}" width="40" height="10" /><i>Confidential</i></p>`,
    } })
    let bytes = await exportWordDocx(store.getSnapshot().documents[0]!)
    for (let cycle = 0; cycle < 2; cycle++) {
      const zip = await JSZip.loadAsync(bytes)
      const headerXml = await zip.file('word/header.xml')!.async('string')
      expect(headerXml).toContain('cx="762000" cy="190500"')
      expect(headerXml).toContain('<w:b/>')
      expect(await zip.file('word/_rels/header.xml.rels')!.async('string')).toContain('relationships/image')
      // Exercise ordinary external DOCX import, not the embedded native snapshot.
      zip.remove('bridgic/editor-model.json')
      const imported = await importDocxToHtml(await zip.generateAsync({ type: 'uint8array' }))
      expect(imported.document).toBeUndefined()
      expect(imported.layout!.headerFooter.headerHtml).toContain('<strong>Brand</strong>')
      expect(imported.layout!.headerFooter.headerHtml).toContain('width="80" height="20"')
      const { page, headerFooter } = imported.layout!
      const reopened = createWordDomainStore(createEmptyWordWorkspace(`rich-header-${cycle}`), { defaultTitle: 'Report' })
      try {
        expect((await reopened.dispatch({ type: 'document.open', title: 'Report.docx', sourcePath: '/Report.docx', sourceMtimeMs: cycle + 1, ...imported, document: {
          snapshot: createUniverDocumentSnapshot('imported', 'Report', page, headerFooter, imported.html),
          page, headerFooter, footnotes: [], citations: [],
        } })).ok).toBe(true)
        const document = reopened.getSnapshot().documents[0]!
        const header = document.snapshot.headers![document.snapshot.documentStyle.defaultHeaderId!]!.body
        const footer = document.snapshot.footers![document.snapshot.documentStyle.defaultFooterId!]!.body
        expect(header.customBlocks).toHaveLength(1)
        expect(footer.customBlocks).toHaveLength(1)
        expect(header.textRuns!.some((run) => run.ts?.bl === 1)).toBe(true)
        expect(footer.textRuns!.some((run) => run.ts?.it === 1)).toBe(true)
        expect(Object.values(document.snapshot.drawings!)).toHaveLength(2)
        await reopened.dispatch({ type: 'document.append', text: `Correction ${cycle}` })
        bytes = await exportWordDocx(reopened.getSnapshot().documents[0]!)
      } finally { reopened.dispose() }
    }
    store.dispose()
  })

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


it('keeps editing and navigation independent of DOCX export failures until an explicit save', async () => {
  const save = mock(async (): Promise<OfficeFileSaveResult> => { throw new Error('DOCX export failed') })
  const confirm = mock(async () => 'discard' as const)
  const store = createWordDomainStore(createEmptyWordWorkspace('explicit-word'), { defaultTitle: 'Report', saveDocument: save, confirmClose: confirm })
  expect((await store.dispatch({ type: 'document.create' })).ok).toBe(true)
  const id = store.getSnapshot().activeDocumentId
  expect((await store.dispatch({ type: 'document.append', text: 'Retained edit' })).ok).toBe(true)
  const detach = store.registerEditorCommandHandler(id, async () => {
    const document = store.getSnapshot().documents[0]!
    return store.commitEditorSnapshot(id, { ...document.snapshot, body: { dataStream: 'Retained edit and native formatting\r\n' } })
  })
  expect((await store.dispatch({ type: 'editor.format', action: 'bold' })).ok).toBe(true)
  expect(save).not.toHaveBeenCalled()
  expect(await store.dispatch({ type: 'document.save' })).toMatchObject({ ok: false, error: { message: 'DOCX export failed' } })
  expect(save).toHaveBeenCalledTimes(1)
  expect((await store.dispatch({ type: 'document.create', title: 'Second document' })).ok).toBe(true)
  expect((await store.dispatch({ type: 'document.activate', documentId: id })).ok).toBe(true)
  expect((await store.dispatch({ type: 'document.open', title: 'Opened.docx', html: '<p>Opened document</p>', sourcePath: '/opened.docx', sourceMtimeMs: 1 })).ok).toBe(true)
  expect(save).toHaveBeenCalledTimes(1)
  expect(store.getSnapshot().documents[0]!.snapshot.body!.dataStream).toContain('Retained edit')
  expect(isWordDocumentDirty(store.getSnapshot().documents[0]!)).toBe(true)
  expect(await store.closeDocumentTab(id)).toMatchObject({ ok: true, value: { closeSurface: false } })
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledTimes(1)
  detach()
  store.dispose()
})

it('rejects a parsed Word replacement when native input changes during the final flush', async () => {
  const store = createWordDomainStore(createEmptyWordWorkspace('reopen-native'), { defaultTitle: 'Report', saveDocument: async () => saved })
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
