import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { CustomRangeType, ListGlyphType, PRESET_LIST_TYPE } from '@univerjs/core'

GlobalRegistrator.register()

const {
  countWordContent,
  createEmptyWordWorkspace,
  createWordDomainStore,
  createWordWorkspace,
  isWordDocumentDirty,
  reduceWordCommand,
  restoreWordWorkspace,
  sanitizeWordHtml,
} = await import('../wordDomain')
const { createUniverDocumentSnapshot, createUniverSectionedDocumentSnapshot, getUniverDocumentText, htmlToUniverSnapshot, insertReferenceInSnapshot } = await import('../wordUniverModel')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('Word renderer domain', () => {
  it('replaces HTML body assets without aliasing native segments or retaining removed body resources', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6T4cAAAAASUVORK5CYII='
    const random = spyOn(Math, 'random').mockReturnValue(0.25)
    const native = htmlToUniverSnapshot(`<p>Old body<img src="${image}"/><a href="https://old.example">Old link</a></p><table><tr><td>Old table</td></tr></table><ol><li>Old list</li></ol>`, 'native-rich-parts', 'Report')
    const oldDrawingId = native.body!.customBlocks![0]!.blockId
    const oldTableId = native.body!.tables![0]!.tableId
    const oldListId = native.body!.paragraphs!.find((paragraph) => paragraph.bullet)!.bullet!.listId
    random.mockReturnValue(0.5)
    const part = htmlToUniverSnapshot(`<p>Brand<img src="${image}" width="80" height="20"/><a href="https://brand.example">Brand link</a><sup data-word-footnote-id="shared-note" data-word-footnote-text="Header note">1</sup></p><table><tr><td>Header table</td></tr></table><ol><li>Custom native list</li><li>Native preset override</li></ol><ul><li>Native fallback bullet</li></ul>`, native.id, native.title!)
    const nativeList = part.body!.paragraphs!.find((paragraph) => paragraph.bullet)!.bullet!
    nativeList.listType = 'CUSTOM_NATIVE'
    part.lists!.CUSTOM_NATIVE = { ...structuredClone(PRESET_LIST_TYPE.ORDER_LIST!), listType: 'CUSTOM_NATIVE' }
    part.lists!.CUSTOM_NATIVE.nestingLevel[0]!.startNumber = 23
    part.lists!.ORDER_LIST = { ...structuredClone(PRESET_LIST_TYPE.ORDER_LIST!), listType: 'ORDER_LIST' }
    part.lists!.ORDER_LIST.nestingLevel[0]!.startNumber = 17
    for (const key of ['drawings', 'tableSource', 'lists'] as const) Object.assign(native[key]!, part[key])
    const retainedDrawingId = part.body!.customBlocks![0]!.blockId
    native.drawingsOrder!.push(retainedDrawingId)
    native.headerFooterDrawingsOrder = [retainedDrawingId]
    native.headers = { brand: { headerId: 'brand', body: part.body! }, blank: { headerId: 'blank', body: htmlToUniverSnapshot('<p><br></p>', native.id, '').body! } }
    native.footers = { shared: { footerId: 'shared', body: structuredClone(part.body!) } }
    native.documentStyle = {
      ...native.documentStyle, pageSize: { width: 1200, height: 700 }, pageOrient: 1,
      marginTop: 41, marginBottom: 43, marginLeft: 47, marginRight: 53,
      defaultHeaderId: 'brand', firstPageHeaderId: 'blank', evenPageHeaderId: 'blank',
      defaultFooterId: 'shared', useFirstPageHeaderFooter: 1, evenAndOddHeaders: 1, pageNumberStart: 6,
    }
    native.resources = [
      { name: 'DOC_DRAWING_PLUGIN', data: JSON.stringify({ oldDrawingId }) },
      { name: 'DOC_HYPER_LINK_PLUGIN', data: JSON.stringify({ oldLink: 'https://old.example' }) },
      { name: 'CUSTOM_PLUGIN', data: 'preserved' },
    ]
    const store = createWordDomainStore(createEmptyWordWorkspace('replace-rich-parts'), { defaultTitle: 'Report' })
    try {
      expect((await store.dispatch({ type: 'document.create', snapshot: native })).ok).toBe(true)
      const before = store.getSnapshot().documents[0]!
      const beforeSnapshot = structuredClone(before.snapshot)
      const html = `<h1>Replacement</h1><p><img src="${image}" width="24" height="12"/><a href="https://new.example">New link</a><sup data-word-footnote-id="shared-note" data-word-footnote-text="Replacement note">1</sup><span data-word-citation-id="new-citation" data-word-citation-text="Author, 2026">Author</span></p><table><tr><td>Replacement table</td></tr></table><ol><li>Outer number<ul><li>Inner bullet</li></ul></li><li>Second number</li></ol>`
      expect((await store.dispatch({ type: 'document.update', html })).ok).toBe(true)
      const updated = store.getSnapshot().documents[0]!
      expect(before.snapshot).toEqual(beforeSnapshot)
      expect(updated.snapshot.documentStyle).toEqual(beforeSnapshot.documentStyle)
      expect(updated.snapshot.headers).toEqual(beforeSnapshot.headers)
      expect(updated.snapshot.footers).toEqual(beforeSnapshot.footers)
      expect(updated.page).toEqual(before.page)
      expect(updated.headerFooter).toEqual(before.headerFooter)
      expect(updated.snapshot.drawings![oldDrawingId]).toBeUndefined()
      expect(updated.snapshot.tableSource![oldTableId]).toBeUndefined()
      expect(updated.snapshot.lists![oldListId]).toBeUndefined()
      expect(updated.snapshot.drawings![retainedDrawingId]).toEqual(beforeSnapshot.drawings![retainedDrawingId])
      for (const [id, table] of Object.entries(part.tableSource!)) expect(updated.snapshot.tableSource![id]).toEqual(table)
      for (const [id, list] of Object.entries(part.lists!)) expect(updated.snapshot.lists![id]).toEqual(list)
      const body = updated.snapshot.body!
      const bodyDrawing = body.customBlocks![0]!.blockId
      const bodyTable = body.tables![0]!.tableId
      expect(bodyDrawing).not.toBe(retainedDrawingId)
      expect(updated.snapshot.drawings![bodyDrawing]!.drawingId).toBe(bodyDrawing)
      expect(updated.snapshot.drawings![bodyDrawing]!.docTransform!.size).toEqual({ width: 24, height: 12 })
      expect(Object.keys(part.tableSource!)).not.toContain(bodyTable)
      expect(updated.snapshot.tableSource![bodyTable]!.tableId).toBe(bodyTable)
      expect(updated.snapshot.drawingsOrder).toEqual([retainedDrawingId, bodyDrawing])
      expect(updated.snapshot.headerFooterDrawingsOrder).toEqual([retainedDrawingId])
      const bullets = body.paragraphs!.flatMap((paragraph) => paragraph.bullet ? [paragraph.bullet] : [])
      expect(bullets).toHaveLength(3)
      expect(bullets[0]!.listId).toBe(bullets[2]!.listId)
      expect(bullets[1]!.listId).not.toBe(bullets[0]!.listId)
      expect(bullets[0]!.listId).not.toBe(nativeList.listId)
      expect(bullets[0]!.listType).not.toBe('ORDER_LIST')
      expect(bullets[1]!.listType).not.toBe('BULLET_LIST')
      expect(updated.snapshot.lists!.BULLET_LIST).toBeUndefined()
      expect(updated.snapshot.lists![bullets[0]!.listType]!.nestingLevel[0]).toMatchObject({ glyphType: ListGlyphType.DECIMAL, startNumber: PRESET_LIST_TYPE.ORDER_LIST!.nestingLevel[0]!.startNumber })
      expect(updated.snapshot.lists![bullets[1]!.listType]!.nestingLevel[1]!.glyphSymbol).toBeTruthy()
      expect(body.customRanges!.find((range) => range.rangeType === CustomRangeType.HYPERLINK)!.properties!.url).toBe('https://new.example')
      expect(updated.footnotes).toEqual([{ id: 'shared-note-body', number: 1, text: 'Replacement note' }])
      expect(updated.citations).toEqual([{ id: 'new-citation', text: 'Author, 2026' }])
      expect(body.customRanges!.find((range) => range.properties?.bridgicKind === 'footnote')!.rangeId).toBe(updated.footnotes[0]!.id)
      expect(updated.snapshot.resources).toEqual([{ name: 'CUSTOM_PLUGIN', data: 'preserved' }])
      expect(store.commitEditorSnapshot(updated.id, beforeSnapshot)).toBe(true)
      expect(store.getSnapshot().documents[0]!.snapshot).toEqual(beforeSnapshot)
      expect(store.commitEditorSnapshot(updated.id, updated.snapshot)).toBe(true)
      expect(store.getSnapshot().documents[0]!.footnotes).toEqual(updated.footnotes)
    } finally { random.mockRestore(); store.dispose() }
  })

  it('moves native main section styles onto replacement boundaries without applying them to table cells', async () => {
    const page = { size: 'a4', orientation: 'portrait', margins: 'normal' } as const
    const headerFooter = { headerHtml: '', footerHtml: '', showPageNumbers: false, differentFirstPage: false, pageNumberStart: 1 }
    for (const sectionCount of [1, 2]) {
      const native = createUniverSectionedDocumentSnapshot('sections', 'Report', page, headerFooter, [
        { html: '<table><tr><td>Old cell</td></tr></table><p>First section</p>', style: { pageSize: { width: 1200, height: 700 }, marginLeft: 47, pageNumberStart: 6, defaultHeaderId: 'section-header', sectionType: 0 }, parts: [{ kind: 'header', variant: 'default', id: 'section-header', html: '<p>Section brand</p>' }] },
        ...(sectionCount === 2 ? [{ html: '<p>Second section</p>', style: { pageSize: { width: 600, height: 900 }, marginLeft: 29, pageNumberStart: 11 }, parts: [] }] : []),
      ])
      const store = createWordDomainStore(createEmptyWordWorkspace(`replace-sections-${sectionCount}`), { defaultTitle: 'Report' })
      try {
        expect((await store.dispatch({ type: 'document.create', snapshot: native })).ok).toBe(true)
        const before = store.getSnapshot().documents[0]!.snapshot
        const first = before.body!.sectionBreaks!.find((section) => section.defaultHeaderId === 'section-header')!
        expect((await store.dispatch({ type: 'document.update', html: '<p>New shorter content</p><table><tr><td>New cell</td></tr></table>' })).ok).toBe(true)
        const updated = store.getSnapshot().documents[0]!.snapshot
        const body = updated.body!
        expect(updated.documentStyle).toEqual(before.documentStyle)
        expect(updated.headers).toEqual(before.headers)
        expect(body.sectionBreaks!.at(-1)).toEqual({ ...first, startIndex: body.dataStream.length - 1 })
        expect(body.sectionBreaks!.at(-1)!.startIndex).not.toBe(first.startIndex)
        const cellSections = body.sectionBreaks!.slice(0, -1)
        expect(cellSections).toHaveLength(1)
        expect(cellSections[0]!.pageSize).toBeUndefined()
        expect(cellSections[0]!.defaultHeaderId).toBeUndefined()
      } finally { store.dispose() }
    }
  })

  it('derives all page and header/footer controls when creating a native document', async () => {
    const page = { size: 'letter', orientation: 'landscape', margins: 'narrow' } as const
    const native = createUniverDocumentSnapshot('external', 'External', page, {
      headerHtml: '<p>Native header</p>', footerHtml: '<p>Native footer</p>',
      showPageNumbers: true, differentFirstPage: true, pageNumberStart: 9,
    }, '<p>Native body</p>')
    const store = createWordDomainStore(createEmptyWordWorkspace('native-create'), { defaultTitle: 'Report' })
    try {
      expect((await store.dispatch({ type: 'document.create', snapshot: native })).ok).toBe(true)
      const created = store.getSnapshot().documents[0]!
      expect(created.page).toEqual(page)
      expect(created.headerFooter).toMatchObject({ showPageNumbers: true, differentFirstPage: true, pageNumberStart: 9 })
      expect(created.headerFooter.headerHtml).toContain('Native header')
      expect(created.headerFooter.footerHtml).toContain('Native footer')
      expect(created.snapshot.documentStyle).toEqual(native.documentStyle)
      await store.dispatch({ type: 'document.headerFooter.update', settings: { showPageNumbers: false } })
      const updated = store.getSnapshot().documents[0]!
      expect(updated.snapshot.documentStyle).toMatchObject({ pageNumberStart: 9, useFirstPageHeaderFooter: 1, bridgicShowPageNumbers: false })
      expect(updated.snapshot.headers).toEqual(native.headers)
      expect(updated.snapshot.footers).toEqual(native.footers)
    } finally { store.dispose() }
  })

  it('updates native geometry and removed segments without restoring cached settings', async () => {
    const store = createWordDomainStore(createWordWorkspace('native-update', 'Report'), { defaultTitle: 'Report' })
    try {
      await store.dispatch({ type: 'document.headerFooter.update', settings: { headerHtml: '<p>Old header</p>', footerHtml: '<p>Old footer</p>' } })
      const document = store.getSnapshot().documents[0]!
      const native = structuredClone(document.snapshot)
      native.headers = {}
      native.footers = {}
      native.documentStyle = {
        ...native.documentStyle,
        pageSize: { width: 1200, height: 700 }, pageOrient: 1,
        marginTop: 41, marginBottom: 43, marginLeft: 47, marginRight: 53,
        defaultHeaderId: '', defaultFooterId: '', useFirstPageHeaderFooter: 1, pageNumberStart: 7,
      }
      native.body!.sectionBreaks = [{ startIndex: native.body!.dataStream.length - 1, pageSize: { width: 600, height: 900 }, marginLeft: 29 }]
      expect((await store.dispatch({ type: 'document.update', snapshot: native })).ok).toBe(true)
      const updated = store.getSnapshot().documents[0]!
      expect(updated.snapshot.documentStyle).toEqual(native.documentStyle)
      expect(updated.snapshot.body!.sectionBreaks).toEqual(native.body!.sectionBreaks)
      expect(updated.snapshot.headers).toEqual({})
      expect(updated.snapshot.footers).toEqual({})
      expect(updated.page.orientation).toBe('landscape')
      expect(updated.headerFooter).toMatchObject({ headerHtml: '', footerHtml: '', differentFirstPage: true, pageNumberStart: 7 })
      await store.dispatch({ type: 'document.headerFooter.update', settings: { showPageNumbers: true } })
      expect(store.getSnapshot().documents[0]!.snapshot.documentStyle).toMatchObject({ pageNumberStart: 7, useFirstPageHeaderFooter: 1 })
      expect(store.getSnapshot().documents[0]!.snapshot.headers).toEqual({})
      expect(store.getSnapshot().documents[0]!.snapshot.footers).toEqual({})
    } finally { store.dispose() }
  })

  it('retains imported HTML and layout when the import has no valid native snapshot', async () => {
    for (const snapshot of [undefined, { body: {} }]) {
      const store = createWordDomainStore(createEmptyWordWorkspace('html-import'), { defaultTitle: 'Report' })
      try {
        const page = { size: 'letter', orientation: 'landscape', margins: 'narrow' } as const
        expect((await store.dispatch({
          type: 'document.open', title: 'Report.docx', html: '<p>Imported body</p>', sourcePath: '/Report.docx', sourceMtimeMs: 1,
          document: { snapshot, page, headerFooter: { headerHtml: '<p>Imported header</p>', showPageNumbers: true, pageNumberStart: 4 } },
        })).ok).toBe(true)
        const imported = store.getSnapshot().documents[0]!
        expect(getUniverDocumentText(imported.snapshot)).toContain('Imported body')
        expect(imported.page).toEqual(page)
        expect(imported.headerFooter).toMatchObject({ headerHtml: '<p>Imported header</p>', showPageNumbers: true, pageNumberStart: 4 })
        expect(imported.snapshot.headers![imported.snapshot.documentStyle.defaultHeaderId!]!.body.dataStream).toContain('Imported header')
      } finally { store.dispose() }
    }
  })

  it('derives numbering controls from native snapshots during update, commit and restore', async () => {
    const store = createWordDomainStore(createWordWorkspace('native-numbering', 'Report'), { defaultTitle: 'Report' })
    try {
      const before = structuredClone(store.getSnapshot().documents[0]!.snapshot)
      await store.dispatch({ type: 'document.headerFooter.update', settings: { showPageNumbers: true, pageNumberStart: 3 } })
      expect(store.getSnapshot().documents[0]!.headerFooter.showPageNumbers).toBe(true)
      const enabled = structuredClone(store.getSnapshot().documents[0]!.snapshot)
      expect(store.commitEditorSnapshot(before.id, before)).toBe(true)
      expect(store.getSnapshot().documents[0]!.headerFooter).toMatchObject({ showPageNumbers: false, pageNumberStart: 1 })
      const restored = structuredClone(store.getSnapshot())
      restored.documents[0]!.headerFooter.showPageNumbers = true
      expect(restoreWordWorkspace(restored, restored.sessionId, 'Report').documents[0]!.headerFooter.showPageNumbers).toBe(false)
      await store.dispatch({ type: 'document.update', snapshot: enabled })
      expect(store.getSnapshot().documents[0]!.headerFooter.showPageNumbers).toBe(true)
      await store.dispatch({ type: 'document.create', title: 'Native numbered document', snapshot: enabled })
      expect(store.getSnapshot().documents[1]!.headerFooter.showPageNumbers).toBe(true)
      await store.dispatch({ type: 'document.headerFooter.update', settings: { pageNumberStart: 2 } })
      expect(store.getSnapshot().documents[1]!.headerFooter).toMatchObject({ showPageNumbers: true, pageNumberStart: 2 })
      expect(store.getSnapshot().documents[1]!.snapshot.documentStyle).toMatchObject({ bridgicShowPageNumbers: true })
    } finally { store.dispose() }
  })

  it('preserves native custom geometry and removed parts through commit and current workspace restore', () => {
    const initial = createWordWorkspace('custom-layout', 'Current title')
    const document = initial.documents[0]!
    document.sourcePath = '/tmp/current.docx'
    document.sourceMtimeMs = 42
    document.sourceProtected = false
    document.contentVersion = 8
    document.savedContentVersion = 7
    document.page = { size: 'letter', orientation: 'portrait', margins: 'wide' }
    document.headerFooter.headerHtml = '<p>Stale removed header</p>'
    document.headerFooter.footerHtml = '<p>Stale removed footer</p>'
    document.headerFooter.differentFirstPage = false
    document.headerFooter.pageNumberStart = 1
    document.headerFooter.showPageNumbers = true
    document.snapshot.documentStyle = {
      ...document.snapshot.documentStyle,
      pageSize: { width: 1200, height: 700 },
      pageOrient: 1,
      marginTop: 41,
      marginBottom: 43,
      marginLeft: 47,
      marginRight: 53,
      marginHeader: 19,
      marginFooter: 23,
      useFirstPageHeaderFooter: 1,
      pageNumberStart: 6,
    }
    document.snapshot.body!.sectionBreaks = [{
      startIndex: document.snapshot.body!.dataStream.length - 1,
      pageSize: { width: 600, height: 900 },
      pageOrient: 0,
      marginLeft: 29,
      marginRight: 31,
    }]
    const expectedSections = structuredClone(document.snapshot.body!.sectionBreaks)
    const store = createWordDomainStore(initial, { defaultTitle: 'Report' })
    try {
      const restored = store.getSnapshot().documents[0]!
      expect(restored.snapshot.documentStyle).toEqual(document.snapshot.documentStyle)
      expect(restored.snapshot.body!.sectionBreaks).toEqual(expectedSections)
      expect(restored.page).toEqual({ size: 'letter', orientation: 'landscape', margins: 'wide' })
      expect(restored.headerFooter).toMatchObject({
        headerHtml: '', footerHtml: '', differentFirstPage: true, pageNumberStart: 6, showPageNumbers: false,
      })

      const native = structuredClone(restored.snapshot)
      native.id = 'old-native-identity'
      native.title = 'Old native title'
      native.documentStyle.marginTop = 37
      native.documentStyle.marginLeft = 39
      native.documentStyle.pageOrient = 0
      native.documentStyle.useFirstPageHeaderFooter = 0
      native.documentStyle.pageNumberStart = 2
      expect(store.commitEditorSnapshot(document.id, native)).toBe(true)
      const committed = store.getSnapshot().documents[0]!
      expect(committed).toMatchObject({
        id: document.id,
        title: 'Current title',
        sourcePath: '/tmp/current.docx',
        sourceMtimeMs: 42,
        sourceProtected: false,
        contentVersion: 9,
        savedContentVersion: 7,
        page: { orientation: 'portrait' },
        headerFooter: { headerHtml: '', footerHtml: '', differentFirstPage: false, pageNumberStart: 2 },
      })
      expect(committed.snapshot.id).toBe(document.id)
      expect(committed.snapshot.title).toBe('Current title')
      expect(committed.snapshot.documentStyle).toEqual(native.documentStyle)
      expect(committed.snapshot.body!.sectionBreaks).toEqual(expectedSections)

      const reopened = restoreWordWorkspace(store.getSnapshot(), 'custom-layout', 'Report').documents[0]!
      expect(reopened).toEqual(committed)
      expect(Object.keys(reopened.snapshot.headers ?? {})).toEqual([])
      expect(Object.keys(reopened.snapshot.footers ?? {})).toEqual([])
    } finally { store.dispose() }
  })

  it('keeps unchanged and untargeted native header/footer content intact', async () => {
    const store = createWordDomainStore(createWordWorkspace('rich-parts', 'Report'), { defaultTitle: 'Report' })
    try {
      await store.dispatch({ type: 'document.headerFooter.update', settings: { headerHtml: '<p><b>Brand</b></p>', footerHtml: '<p><i>Confidential</i></p>' } })
      const initial = store.getSnapshot()
      expect((await store.dispatch({ type: 'document.headerFooter.update', settings: { headerHtml: '<p><b>Brand</b></p>' } })).ok).toBe(true)
      expect(store.getSnapshot()).toBe(initial)
      const document = initial.documents[0]!
      const native = structuredClone(document.snapshot)
      const header = native.headers![native.documentStyle.defaultHeaderId!]!.body
      header.textRuns![0]!.ts!.cl = { rgb: '#123456' }
      store.commitEditorSnapshot(document.id, native)
      expect((await store.dispatch({ type: 'document.headerFooter.update', settings: { footerHtml: '<p><i>Updated footer</i></p>' } })).ok).toBe(true)
      const updated = store.getSnapshot().documents[0]!
      expect(updated.snapshot.headers).toEqual(native.headers)
      expect(updated.snapshot.body).toEqual(native.body)
      expect(updated.snapshot.footers![updated.snapshot.documentStyle.defaultFooterId!]!.body.dataStream).toContain('Updated footer')
      const beforeNumbering = updated.snapshot
      await store.dispatch({ type: 'document.headerFooter.update', settings: { pageNumberStart: 3, showPageNumbers: true } })
      expect(store.getSnapshot().documents[0]!.snapshot.headers).toEqual(beforeNumbering.headers)
      expect(store.getSnapshot().documents[0]!.snapshot.footers).toEqual(beforeNumbering.footers)
    } finally { store.dispose() }
  })

  it('isolates one workspace to its Session and manages internal document tabs', async () => {
    const initial = createWordWorkspace('session-word', 'Untitled document')
    const store = createWordDomainStore(initial, { defaultTitle: 'Untitled document' })

    const created = await store.dispatch({
      type: 'document.create',
      title: 'Plan',
      html: '<h1>Plan</h1><p>First draft</p>',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.state.sessionId).toBe('session-word')
    expect(created.state.documents).toHaveLength(2)
    expect(created.state.documents.find((item) => item.id === created.state.activeDocumentId)?.title)
      .toBe('Plan')

    const appended = await store.dispatch({
      type: 'document.append',
      text: 'Review risks',
      block: 'heading2',
    })
    expect(appended.ok).toBe(true)
    if (!appended.ok) return
    const appendedDocument = appended.state.documents.find((item) => item.id === appended.state.activeDocumentId)
    expect(getUniverDocumentText(appendedDocument!.snapshot)).toContain('Review risks')
    expect(appendedDocument?.snapshot.body?.paragraphs?.at(-1)?.paragraphStyle?.namedStyleType).toBe(5)

    const closed = await store.dispatch({
      type: 'document.close',
      documentId: appended.state.activeDocumentId,
    })
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    expect(closed.state.documents).toHaveLength(1)
    expect(closed.state.activeDocumentId).toBe(initial.activeDocumentId)
  })

  it('supports an unopened workspace and returns to it after the final document closes', async () => {
    const store = createWordDomainStore(createEmptyWordWorkspace('session-word'), { defaultTitle: 'Untitled document' })
    expect(store.getSnapshot()).toMatchObject({ activeDocumentId: '', documents: [] })

    const created = await store.dispatch({ type: 'document.create' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.state.documents).toHaveLength(1)

    const closed = await store.dispatch({ type: 'document.close', documentId: created.state.activeDocumentId })
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    expect(closed.state).toMatchObject({ activeDocumentId: '', documents: [] })
  })

  it('reuses an unchanged source from the public API without resetting live edits or reading unused images', async () => {
    const store = createWordDomainStore(createEmptyWordWorkspace('word-repeat-open'), { defaultTitle: 'Report' })
    const open = { type: 'document.open', title: 'Report.docx', html: '<p>On disk</p>', sourcePath: '/work/Report.docx', sourceMtimeMs: 1, sourceProtected: false }
    const previousFiles = window.officeFiles
    const readImage = mock(async () => { throw new Error('Unused import image is unavailable') })
    window.officeFiles = {
      inspect: async () => ({ path: open.sourcePath, mtimeMs: 1 }),
      save: async () => ({ ok: false, reason: 'canceled' }),
      confirmClose: async () => 'cancel',
      readImage,
    }
    try {
      expect((await store.api.dispatch(open)).ok).toBe(true)
      const id = store.getSnapshot().activeDocumentId
      expect((await store.api.dispatch({ type: 'document.append', text: 'Unsaved live edit' })).ok).toBe(true)
      const live = store.getSnapshot().documents[0]!
      const revision = store.api.workspace.getSnapshot().documents[0]!.revision
      const reopen = { ...open, title: 'Unused title', html: '<p>Old bytes<img src="https://example.com/unused.png"/></p>', sourceProtected: true }
      expect((await store.api.dispatch(reopen)).ok).toBe(true)
      expect(store.getSnapshot().documents[0]).toBe(live)
      expect(store.api.workspace.getSnapshot().documents[0]!.revision).toBe(revision)
      expect((await store.api.dispatch({ type: 'document.create', title: 'Other tab' })).ok).toBe(true)
      expect((await store.api.dispatch(reopen)).ok).toBe(true)
      expect(store.getSnapshot().activeDocumentId).toBe(id)
      expect(store.getSnapshot().documents).toHaveLength(2)
      expect(store.getSnapshot().documents[0]).toBe(live)
      expect(isWordDocumentDirty(live)).toBe(true)
      expect(getUniverDocumentText(live.snapshot)).toContain('Unsaved live edit')
      expect(readImage).not.toHaveBeenCalled()
    } finally { window.officeFiles = previousFiles; store.dispose() }
  })

  it('flushes pending native input before rejecting a changed source', async () => {
    const store = createWordDomainStore(createEmptyWordWorkspace('word-open-native-flush'), { defaultTitle: 'Report' })
    const open = { type: 'document.open', title: 'Report.docx', html: '<p>On disk</p>', sourcePath: '/work/Report.docx', sourceMtimeMs: 1 }
    try {
      expect((await store.dispatch(open)).ok).toBe(true)
      const id = store.getSnapshot().activeDocumentId
      const native = htmlToUniverSnapshot('<p>Pending native typing</p>', id, 'Report.docx')
      const flush = mock(async () => { store.commitEditorSnapshot(id, native) })
      store.registerEditorCommandHandler(id, async () => true, flush)
      const changed = await store.api.dispatch({ ...open, sourceMtimeMs: 2, html: '<p>External content</p>' })
      expect(changed).toMatchObject({ ok: false, error: { code: 'source_conflict' } })
      expect(flush).toHaveBeenCalledTimes(1)
      expect(getUniverDocumentText(store.getSnapshot().documents[0]!.snapshot)).toContain('Pending native typing')
      expect(store.getSnapshot().documents[0]!.sourceMtimeMs).toBe(1)
      expect(isWordDocumentDirty(store.getSnapshot().documents[0]!)).toBe(true)
      const reused = await store.api.dispatch(open)
      expect(reused.ok).toBe(true)
      expect(isWordDocumentDirty(store.getSnapshot().documents[0]!)).toBe(true)
    } finally { store.dispose() }
  })

  it('opens a DOCX source once and refreshes the same tab when the source changes', async () => {
    const store = createWordDomainStore(createEmptyWordWorkspace('session-word'), { defaultTitle: 'Untitled document' })

    const opened = await store.dispatch({
      type: 'document.open',
      title: 'report.docx',
      html: '<h1>First version</h1><p>Imported body</p>',
      sourcePath: '/tmp/report.docx',
      sourceMtimeMs: 10,
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const documentId = opened.state.activeDocumentId
    expect(opened.state.documents).toHaveLength(1)
    expect(opened.state.documents[0]).toMatchObject({
      id: documentId,
      title: 'report.docx',
      sourcePath: '/tmp/report.docx',
      sourceMtimeMs: 10,
    })
    expect(getUniverDocumentText(opened.state.documents[0]!.snapshot)).toContain('First version')

    const refreshed = await store.dispatch({
      type: 'document.open',
      title: 'renamed-report.docx',
      html: '<h1>Second version</h1>',
      sourcePath: '/tmp/report.docx',
      sourceMtimeMs: 20,
    })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) return
    expect(refreshed.state.documents).toHaveLength(1)
    expect(refreshed.state.documents[0]).toMatchObject({
      id: documentId,
      title: 'renamed-report.docx',
      sourcePath: '/tmp/report.docx',
      sourceMtimeMs: 20,
    })
    expect(getUniverDocumentText(refreshed.state.documents[0]!.snapshot)).toContain('Second version')
  })

  it('returns structured errors instead of accepting invalid commands', () => {
    const initial = createWordWorkspace('session-word', 'Untitled document')
    const missing = reduceWordCommand(initial, {
      type: 'document.update',
      documentId: 'other-session-document',
      html: '<p>Wrong owner</p>',
    }, 'Untitled document')
    expect(missing).toEqual({
      ok: false,
      error: {
        code: 'document_not_found',
        message: 'The requested Word document does not exist in this Session.',
      },
    })

    const unsupported = reduceWordCommand(initial, { type: 'toolbar.click' }, 'Untitled document')
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) expect(unsupported.error.code).toBe('unsupported_command')
  })

  it('persists validated page setup inside the Session document model', () => {
    const initial = createWordWorkspace('session-word', 'Untitled document')
    expect(initial.documents[0]?.page).toEqual({ size: 'a4', orientation: 'portrait', margins: 'normal' })

    const updated = reduceWordCommand(initial, {
      type: 'document.page.update',
      page: { size: 'letter', orientation: 'landscape', margins: 'narrow' },
    }, 'Untitled document')
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.state.documents[0]?.page).toEqual({
      size: 'letter',
      orientation: 'landscape',
      margins: 'narrow',
    })

    const invalid = reduceWordCommand(updated.state, {
      type: 'document.page.update',
      page: { orientation: 'diagonal' },
    }, 'Untitled document')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid_page_settings')
  })

  it('sanitizes restored and dispatched rich text', () => {
    const sanitized = sanitizeWordHtml(
      '<h1 onclick="steal()">Safe</h1><script>alert(1)</script><a href="javascript:steal()">link</a><table onclick="steal()"><tbody><tr><td style="border:1px solid red;position:fixed">Cell</td></tr></tbody></table>',
    )
    expect(sanitized).toBe('<h1>Safe</h1>alert(1)<a>link</a><table><tbody><tr><td style="border: 1px solid red;">Cell</td></tr></tbody></table>')

    const restored = restoreWordWorkspace({
      version: 1,
      sessionId: 'different-session',
      activeDocumentId: 'bad',
      documents: [],
    }, 'session-word', 'Untitled document')
    expect(restored.sessionId).toBe('session-word')
    expect(restored.documents).toHaveLength(0)
  })

  it('rejects obsolete same-Session HTML workspaces instead of migrating them', () => {
    const restored = restoreWordWorkspace({
      version: 1,
      sessionId: 'session-word',
      activeDocumentId: 'legacy-document',
      documents: [{
        id: 'legacy-document',
        title: 'Legacy',
        html: '<h1>Imported heading</h1><p>Imported body</p>',
        page: { size: 'letter', orientation: 'landscape', margins: 'narrow' },
        headerFooter: { headerHtml: '<b>Header</b>', footerHtml: '', showPageNumbers: false, differentFirstPage: false, pageNumberStart: 1 },
        footnotes: [],
        citations: [],
        createdAt: 1,
        updatedAt: 2,
      }],
    }, 'session-word', 'Untitled document')

    expect(restored.version).toBe(2)
    expect(restored.documents).toEqual([])
    expect(restored.activeDocumentId).toBe('')
  })

  it('counts CJK characters and whitespace-delimited words', () => {
    expect(countWordContent('<p>Hello world，你好 2026</p>')).toBe(5)
  })

  it('stores header, footer, footnotes, and citations in the Session document model', () => {
    const initial = createWordWorkspace('session-word', 'Untitled document')
    const headerFooter = reduceWordCommand(initial, {
      type: 'document.headerFooter.update',
      settings: { headerHtml: '<b>Quarterly plan</b>', footerHtml: '<i>Internal</i>', showPageNumbers: true },
    }, 'Untitled document')
    expect(headerFooter.ok).toBe(true)
    if (!headerFooter.ok) return
    expect(headerFooter.state.documents[0]?.headerFooter).toMatchObject({
      headerHtml: '<b>Quarterly plan</b>',
      footerHtml: '<i>Internal</i>',
      showPageNumbers: true,
    })

    const firstFootnote = reduceWordCommand(headerFooter.state, {
      type: 'document.footnote.add',
      footnote: { id: 'source-1', text: 'Primary source' },
    }, 'Untitled document')
    expect(firstFootnote.ok).toBe(true)
    if (!firstFootnote.ok) return
    const secondFootnote = reduceWordCommand(firstFootnote.state, {
      type: 'document.footnote.add',
      footnote: { id: 'source-2', text: 'Supporting source' },
    }, 'Untitled document')
    expect(secondFootnote.ok).toBe(true)
    if (!secondFootnote.ok) return
    expect(secondFootnote.state.documents[0]?.footnotes.map((item) => item.number)).toEqual([1, 2])

    const removed = reduceWordCommand(secondFootnote.state, {
      type: 'document.footnote.remove',
      footnoteId: 'source-1',
    }, 'Untitled document')
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.state.documents[0]?.footnotes).toEqual([{ id: 'source-2', number: 1, text: 'Supporting source' }])

    const citation = reduceWordCommand(removed.state, {
      type: 'document.citation.add',
      citation: { id: 'cite-1', text: 'Author, 2026' },
    }, 'Untitled document')
    expect(citation.ok).toBe(true)
    if (!citation.ok) return
    expect(citation.state.documents[0]?.citations).toEqual([{ id: 'cite-1', text: 'Author, 2026' }])

    const updatedCitation = reduceWordCommand(citation.state, {
      type: 'document.citation.update',
      citationId: 'cite-1',
      text: 'Author, 2027',
    }, 'Untitled document')
    expect(updatedCitation.ok).toBe(true)
    if (!updatedCitation.ok) return
    expect(updatedCitation.state.documents[0]?.citations).toEqual([{ id: 'cite-1', text: 'Author, 2027' }])
    expect(getUniverDocumentText(updatedCitation.state.documents[0]!.snapshot)).toContain('(Author, 2027)')
  })

  it('derives reference state from an externally supplied native snapshot', () => {
    let snapshot = createUniverDocumentSnapshot('external', 'External', {
      size: 'a4',
      orientation: 'portrait',
      margins: 'normal',
    }, {
      headerHtml: '',
      footerHtml: '',
      showPageNumbers: false,
      differentFirstPage: false,
      pageNumberStart: 1,
    }, '<p>Body</p>')
    snapshot = insertReferenceInSnapshot(snapshot, { kind: 'footnote', id: 'note-1', number: 1, text: 'Source' })
    snapshot = insertReferenceInSnapshot(snapshot, { kind: 'citation', id: 'cite-1', text: 'Author, 2026' })

    const created = reduceWordCommand(createEmptyWordWorkspace('session-word'), {
      type: 'document.create',
      title: 'Imported snapshot',
      snapshot,
    }, 'Untitled document')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.state.documents[0]?.footnotes).toEqual([{ id: 'note-1', number: 1, text: 'Source' }])
    expect(created.state.documents[0]?.citations).toEqual([{ id: 'cite-1', text: 'Author, 2026' }])
  })

  it('preserves only safe structured editor attributes', () => {
    const sanitized = sanitizeWordHtml(
      '<nav data-word-toc="true" onclick="bad()"><p data-word-toc-title="true">Contents</p><ol><li data-word-toc-level="2">Section</li></ol></nav>'
      + '<sup data-word-footnote-id="source-1" data-word-footnote-number="2">2</sup>'
      + '<img src="data:image/png;base64,iVBORw0KGgo=" onerror="bad()">',
    )
    expect(sanitized).toContain('<nav data-word-toc="true">')
    expect(sanitized).toContain('data-word-toc-level="2"')
    expect(sanitized).toContain('data-word-footnote-id="source-1"')
    expect(sanitized).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(sanitized).not.toContain('onclick')
    expect(sanitized).not.toContain('onerror')
  })

  it('preserves StarterKit code blocks through the persistence sanitizer', () => {
    expect(sanitizeWordHtml('<pre><code>const answer = 42</code></pre>'))
      .toBe('<pre><code>const answer = 42</code></pre>')
  })

  it('validates editor commands and returns the registered Session adapter result', async () => {
    const store = createWordDomainStore(createWordWorkspace('session-word', 'Untitled document'), { defaultTitle: 'Untitled document' })
    const commands: unknown[] = []
    store.registerEditorCommandHandler(store.getSnapshot().activeDocumentId, async (command) => {
      commands.push(command)
      return true
    })

    expect((await store.api.dispatch({ type: 'editor.format', action: 'copy' })).ok).toBe(true)
    expect((await store.api.dispatch({ type: 'editor.insert', kind: 'table', rows: 3, cols: 4, withHeaderRow: true })).ok).toBe(true)
    const invalid = await store.api.dispatch({ type: 'editor.insert', kind: 'table', rows: -1, cols: 4 })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid_editor_command')
    expect(commands).toEqual([
      { type: 'editor.format', action: 'copy' },
      { type: 'editor.insert', kind: 'table', rows: 3, cols: 4, withHeaderRow: true },
    ])

    store.registerEditorCommandHandler(store.getSnapshot().activeDocumentId, async () => false)
    const rejected = await store.api.dispatch({ type: 'editor.format', action: 'paste' })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe('editor_command_failed')
  })
})
