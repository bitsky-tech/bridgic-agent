import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { BooleanNumber, CustomRangeType, ListGlyphType, PRESET_LIST_TYPE, PresetListType, type IDocumentData } from '@univerjs/core'
import JSZip from 'jszip'

GlobalRegistrator.register()
const { createWordHeaderFooterDraft, mergeWordHeaderFooterDraft, wordHeaderFooterContentSignature } = await import('../wordHeaderFooter')
const { createWordDomainStore, createWordWorkspace } = await import('../wordDomain')
const { createUniverDocumentSnapshot, htmlToUniverSnapshot, normalizeUniverDocumentSnapshot } = await import('../wordUniverModel')
const { exportWordDocx } = await import('../wordDocxExport')
const { importDocxToHtml } = await import('../wordDocxImport')
afterAll(async () => GlobalRegistrator.unregister())

const page = { size: 'a4', orientation: 'portrait', margins: 'normal' } as const
const settings = { headerHtml: '<p>Old header</p>', footerHtml: '<p>Old footer</p>', showPageNumbers: false, differentFirstPage: false, pageNumberStart: 1 }
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6T4cAAAAASUVORK5CYII='

function richSnapshot(): IDocumentData {
  const snapshot = createUniverDocumentSnapshot('report', 'Report', page, settings, '<p>Body text</p>')
  const rich = htmlToUniverSnapshot(`<p><img src="${png}" width="144" height="36"/><strong>Company</strong> website</p><ol><li>Custom list</li></ol><table><tr><td>Cell text</td></tr></table>`, snapshot.id, snapshot.title!)
  snapshot.headers!['bridgic-word-header']!.body = rich.body!
  Object.assign(snapshot.drawings!, rich.drawings)
  Object.assign(snapshot.tableSource!, rich.tableSource)
  Object.assign(snapshot.lists!, rich.lists)
  snapshot.drawingsOrder!.push(...rich.drawingsOrder!)
  snapshot.headerFooterDrawingsOrder = rich.drawingsOrder
  for (const paragraph of rich.body!.paragraphs!) paragraph.paragraphStyle = {
    indentStart: { v: 48 }, indentEnd: { v: 24 }, indentFirstLine: { v: 12 }, hanging: { v: 6 },
    tabStops: [{ offset: 90, alignment: 0 }], lineSpacing: 1.5, spaceAbove: { v: 12 }, spaceBelow: { v: 18 },
    keepNext: BooleanNumber.TRUE,
  }
  rich.body!.textRuns![0]!.ts = { ...rich.body!.textRuns![0]!.ts, fs: 18, sc: 3, sa: 80, ff: 'Arial', cl: { rgb: '#aa0000' } }
  const startIndex = rich.body!.dataStream.indexOf('website')
  rich.body!.customRanges = [{ rangeId: 'native-link', rangeType: CustomRangeType.HYPERLINK, startIndex, endIndex: startIndex + 6, properties: { url: 'https://example.com/?q=one&lang=en' } }]
  rich.body!.customDecorations = [{ id: 'decoration', startIndex: 1, endIndex: 8, type: 0 }]
  const list = Object.values(rich.lists!)[0]!
  list.nestingLevel[0]!.startNumber = 7
  list.nestingLevel[0]!.glyphFormat = '%1)'
  const table = Object.values(rich.tableSource!)[0]!
  table.tableColumns[0]!.size.width.v = 480
  table.tableRows[0]!.tableCells[0]!.backgroundColor = { rgb: '#eeeeee' }
  table.tableRows[0]!.tableCells[0]!.margin = { top: { v: 8 }, bottom: { v: 6 }, start: { v: 10 }, end: { v: 10 } }
  const drawing = Object.values(rich.drawings!)[0]!
  drawing.docTransform.angle = 15
  drawing.distL = 11
  drawing.behindDoc = BooleanNumber.TRUE
  drawing.transform = { ...drawing.transform, angle: 15 }
  snapshot.headers!['first'] = { headerId: 'first', body: htmlToUniverSnapshot('<p>First header</p>', snapshot.id, '').body! }
  snapshot.headers!['even'] = { headerId: 'even', body: htmlToUniverSnapshot('<p>Even header</p>', snapshot.id, '').body! }
  snapshot.footers!['first-footer'] = { footerId: 'first-footer', body: htmlToUniverSnapshot('<p>First footer</p>', snapshot.id, '').body! }
  snapshot.documentStyle.firstPageHeaderId = 'first'
  snapshot.documentStyle.evenPageHeaderId = 'even'
  snapshot.documentStyle.firstPageFooterId = 'first-footer'
  snapshot.resources = [{ name: 'OTHER_PLUGIN', data: 'leave unchanged' }]
  return snapshot
}

describe('Native Word header/footer drafts', () => {
  it.each(['headerHtml', 'footerHtml'] as const)('adds, clears and adds %s again from a real blank document through save/reopen', async (field) => {
    const store = createWordDomainStore(createWordWorkspace(`blank-${field}`, 'Report'), { defaultTitle: 'Report' })
    try {
      const part = field === 'headerHtml' ? 'headers' : 'footers'
      const key = field === 'headerHtml' ? 'defaultHeaderId' : 'defaultFooterId'
      expect(store.getSnapshot().documents[0]!.snapshot.documentStyle[key]).toBe('')
      for (const text of ['First addition', '', 'Second addition']) {
        const current = store.getSnapshot().documents[0]!
        const draft = createWordHeaderFooterDraft(current.snapshot, field)
        expect(draft.segmentId).not.toBe('')
        const merged = mergeWordHeaderFooterDraft(current.snapshot, draft, htmlToUniverSnapshot(`<p>${text}</p>`, draft.snapshot.id, ''))
        expect(store.commitEditorSnapshot(current.id, merged)).toBe(true)
        const document = store.getSnapshot().documents[0]!
        const imported = await importDocxToHtml(await exportWordDocx(document))
        const snapshot = imported.document!.snapshot
        expect(snapshot.documentStyle[key]).toBe(draft.segmentId)
        expect(snapshot[part]![draft.segmentId]!.body.dataStream).toBe(`${text}\r\n`)
        expect(Object.keys(snapshot[part]!)).toEqual([draft.segmentId])
      }
    } finally { store.dispose() }
  })

  it.each(['headerHtml', 'footerHtml'] as const)('recovers an existing %s stored under an empty ID', (field) => {
    const snapshot = createWordWorkspace('empty-id-recovery', 'Report').documents[0]!.snapshot
    const part = field === 'headerHtml' ? 'headers' : 'footers'
    snapshot[part]![''] = field === 'headerHtml'
      ? { headerId: '', body: htmlToUniverSnapshot('<p>Previous draft</p>', snapshot.id, '').body! }
      : { footerId: '', body: htmlToUniverSnapshot('<p>Previous draft</p>', snapshot.id, '').body! }
    const draft = createWordHeaderFooterDraft(snapshot, field)
    expect(draft.snapshot.body!.dataStream).toBe('Previous draft\r\n')
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, draft.snapshot)
    expect(Object.keys(merged[part]!)).toEqual([draft.segmentId])
    expect(draft.segmentId).not.toBe('')
  })

  it.each(['headerHtml', 'footerHtml'] as const)('does not fill a deliberately blank section while editing an existing %s', (field) => {
    const snapshot = richSnapshot()
    const key = field === 'headerHtml' ? 'defaultHeaderId' : 'defaultFooterId'
    snapshot.body!.sectionBreaks!.at(-1)![key] = ''
    const draft = createWordHeaderFooterDraft(snapshot, field)
    const edited = htmlToUniverSnapshot('<p>Updated default</p>', draft.snapshot.id, '')
    expect(mergeWordHeaderFooterDraft(snapshot, draft, edited).body!.sectionBreaks!.at(-1)![key]).toBe('')
  })

  it.each(['headerHtml', 'footerHtml'] as const)('preserves all native %s properties through editing, save and reopening', async (field) => {
    const snapshot = richSnapshot()
    if (field === 'footerHtml') snapshot.footers!['bridgic-word-footer']!.body = structuredClone(snapshot.headers!['bridgic-word-header']!.body)
    const part = field === 'headerHtml' ? 'headers' : 'footers'
    const other = field === 'headerHtml' ? 'footers' : 'headers'
    const draft = createWordHeaderFooterDraft(snapshot, field)
    expect(draft.snapshot.body).toEqual(snapshot[part]![draft.segmentId]!.body)
    expect(draft.snapshot.headers).toEqual({})
    expect(draft.snapshot.footers).toEqual({})
    expect(draft.snapshot.resources).toBeUndefined()
    expect(draft.snapshot.documentStyle.defaultHeaderId).toBeUndefined()
    const edited = structuredClone(draft.snapshot)
    edited.body!.dataStream = edited.body!.dataStream.replace('Company', 'Updated')
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, edited)
    expect(merged[part]![draft.segmentId]!.body).toEqual({ ...snapshot[part]![draft.segmentId]!.body, dataStream: edited.body!.dataStream })
    expect(merged[other]).toEqual(snapshot[other])
    expect(merged.body).toEqual(snapshot.body)
    expect(merged.documentStyle).toEqual(snapshot.documentStyle)
    for (const key of ['drawings', 'tableSource', 'lists', 'drawingsOrder', 'headerFooterDrawingsOrder', 'resources'] as const) expect(merged[key]).toEqual(snapshot[key])
    const store = createWordDomainStore(createWordWorkspace('header-round-trip', 'Report'), { defaultTitle: 'Report' })
    await store.dispatch({ type: 'document.headerFooter.update', settings })
    const current = store.getSnapshot().documents[0]!
    merged.id = current.id
    store.commitEditorSnapshot(current.id, merged)
    const document = store.getSnapshot().documents[0]!
    const bytes = await exportWordDocx(document)
    const imported = await importDocxToHtml(bytes)
    expect(imported.document!.snapshot[part]).toEqual(document.snapshot[part])
    expect(imported.document!.snapshot.drawings).toEqual(document.snapshot.drawings)
    expect(imported.document!.snapshot.lists).toEqual(document.snapshot.lists)
    const archive = await JSZip.loadAsync(bytes)
    const xml = await archive.file(`word/${part === 'headers' ? 'header' : 'footer'}.xml`)!.async('text')
    expect(xml).toContain('Updated')
    expect(xml).toContain('w:left="720" w:right="360"')
    expect(xml).toContain('w:hanging="90"')
    expect(xml).toContain('<w:tab w:val="left" w:pos="1350"/>')
    expect(xml).toContain('<w:keepNext w:val="1"/>')
    expect(xml).toContain('<w:spacing w:val="45"/>')
    expect(xml).toContain('w:hyperlink')
    store.dispose()
  })

  it('never aliases the canonical snapshot or baseline when the native draft changes', () => {
    const snapshot = richSnapshot()
    const expected = structuredClone(snapshot)
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    draft.snapshot.body!.paragraphs![0]!.paragraphStyle!.indentStart!.v = 999
    Object.values(draft.snapshot.drawings!)[0]!.docTransform.angle = 90
    expect(snapshot).toEqual(expected)
    expect(draft.original).toEqual(expected)
  })

  it('does not replace canonical image coordinates with temporary body layout caches', () => {
    const snapshot = richSnapshot()
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    const edited = structuredClone(draft.snapshot)
    const drawing = Object.values(edited.drawings!)[0]!
    drawing.transform = { ...drawing.transform, left: 300, top: 200 }
    drawing.transforms = [{ ...drawing.transform }]
    drawing.isMultiTransform = BooleanNumber.FALSE
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, edited)
    expect(merged.drawings).toEqual(snapshot.drawings)
  })

  it('treats empty native array normalization and image layout caches as non-content changes', () => {
    const draft = createWordHeaderFooterDraft(richSnapshot(), 'headerHtml')
    const next = structuredClone(draft.snapshot)
    next.body!.blockRanges = []
    next.body!.payloads = { clipboard: 'transient' }
    next.body!.paragraphs![0]!.paragraphStyle = Object.fromEntries(Object.entries(next.body!.paragraphs![0]!.paragraphStyle!).reverse())
    const drawing = Object.values(next.drawings!)[0]!
    drawing.transform = { ...drawing.transform, left: 100, top: 100 }
    drawing.transforms = [{ ...drawing.transform }]
    expect(wordHeaderFooterContentSignature(next)).toBe(wordHeaderFooterContentSignature(draft.snapshot))
  })

  it('preserves drawing stacking order relative to images in other segments', () => {
    const snapshot = richSnapshot()
    const originalId = Object.keys(snapshot.drawings!)[0]!
    snapshot.drawings!['footer-logo'] = { ...structuredClone(snapshot.drawings![originalId]!), drawingId: 'footer-logo' }
    snapshot.drawingsOrder = [originalId, 'footer-logo']
    snapshot.headerFooterDrawingsOrder = [...snapshot.drawingsOrder]
    snapshot.footers!['bridgic-word-footer']!.body = { dataStream: '\b\r\n', customBlocks: [{ startIndex: 0, blockId: 'footer-logo' }], paragraphs: [{ startIndex: 1 }], sectionBreaks: [{ startIndex: 2 }] }
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, draft.snapshot)
    expect(merged.drawingsOrder).toEqual(snapshot.drawingsOrder)
    expect(merged.headerFooterDrawingsOrder).toEqual(snapshot.headerFooterDrawingsOrder)
  })

  it('retains live body changes and unrelated plugin resources', () => {
    const snapshot = richSnapshot()
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    const current = structuredClone(snapshot)
    current.body!.dataStream = 'Latest body\r\n'
    current.resources![0]!.data = 'latest plugin state'
    const edited = structuredClone(draft.snapshot)
    edited.body!.dataStream = edited.body!.dataStream.replace('Company', 'Updated')
    const merged = mergeWordHeaderFooterDraft(current, draft, edited)
    expect(merged.body).toEqual(current.body)
    expect(merged.resources).toEqual(current.resources)
  })

  it('accepts a newly inserted native preset list with no persisted list map', () => {
    const snapshot = richSnapshot()
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    const edited = htmlToUniverSnapshot('<ol><li>New ordered item</li></ol>', draft.snapshot.id, '')
    edited.lists = {}
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, edited)
    expect(merged.headers![draft.segmentId]!.body.paragraphs![0]!.bullet!.listType).toBe(PresetListType.ORDER_LIST)
    expect(merged.headers![draft.segmentId]!.body.dataStream).toContain('New ordered item')
  })

  it('isolates shared list definitions keyed by native listType, not just listId', () => {
    const snapshot = richSnapshot()
    snapshot.lists![PresetListType.ORDER_LIST] = structuredClone(PRESET_LIST_TYPE[PresetListType.ORDER_LIST]!)
    snapshot.body!.paragraphs![0]!.bullet = { listId: 'body-list', listType: PresetListType.ORDER_LIST, nestingLevel: 0 }
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    const edited = structuredClone(draft.snapshot)
    edited.lists![PresetListType.ORDER_LIST]!.nestingLevel[0]!.startNumber = 4
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, edited)
    expect(merged.body).toEqual(snapshot.body)
    expect(merged.lists![PresetListType.ORDER_LIST]).toEqual(snapshot.lists![PresetListType.ORDER_LIST])
    const type = merged.headers![draft.segmentId]!.body.paragraphs!.find((p) => p.bullet)!.bullet!.listType
    expect(type).not.toBe(PresetListType.ORDER_LIST)
    expect(merged.lists![type]!.nestingLevel[0]!.startNumber).toBe(4)
  })

  it.each(['drawings', 'tableSource', 'lists'] as const)('isolates edited shared %s from other segments', (key) => {
    const snapshot = richSnapshot()
    snapshot.headers!['first']!.body = structuredClone(snapshot.headers!['bridgic-word-header']!.body)
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    const edited = structuredClone(draft.snapshot)
    const id = Object.keys(edited[key]!)[0]!
    if (key === 'drawings') edited.drawings![id]!.docTransform.angle = 45
    if (key === 'tableSource') edited.tableSource![id]!.tableColumns[0]!.size.width.v = 333
    if (key === 'lists') edited.lists![id]!.nestingLevel[0]!.startNumber = 5
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, edited)
    expect(merged[key]![id]).toEqual(snapshot[key]![id])
    expect(merged.headers!['first']).toEqual(snapshot.headers!['first'])
    expect(Object.keys(merged[key]!)).toHaveLength(Object.keys(snapshot[key]!).length + 1)
    const header = merged.headers![draft.segmentId]!.body
    const changedIds = { drawings: header.customBlocks![0]!.blockId, tableSource: header.tables![0]!.tableId, lists: header.paragraphs!.find((p) => p.bullet)!.bullet!.listId }
    const changedId = changedIds[key]
    expect(changedId).not.toBe(id)
    expect(merged[key]![changedId]).toBeDefined()
  })

  it('clears a segment without restoring stale import HTML or deleting shared assets', () => {
    const snapshot = richSnapshot()
    snapshot.headers!['first']!.body = structuredClone(snapshot.headers!['bridgic-word-header']!.body)
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    const edited = htmlToUniverSnapshot('<p><br></p>', draft.snapshot.id, '')
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, edited)
    expect(merged.headers![draft.segmentId]!.body.dataStream.replace(/[\r\n]/g, '')).toBe('')
    expect(merged.drawings).toEqual(snapshot.drawings)
    expect(merged.tableSource).toEqual(snapshot.tableSource)
    expect(merged.lists).toEqual(snapshot.lists)
    expect(normalizeUniverDocumentSnapshot(merged, merged.id, 'Report', page, settings).headers).toEqual(merged.headers)
  })

  it('removes only deleted assets owned exclusively by the edited segment', () => {
    const snapshot = richSnapshot()
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, htmlToUniverSnapshot('<p>Plain header</p>', draft.snapshot.id, ''))
    expect(merged.drawings).toEqual({})
    expect(merged.drawingsOrder).toEqual([])
    expect(merged.headerFooterDrawingsOrder).toEqual([])
    expect(merged.tableSource).toEqual({})
    expect(merged.lists).toEqual({})
    expect(merged.headers!['first']).toEqual(snapshot.headers!['first'])
  })

  it.each(['headerHtml', 'footerHtml'] as const)('creates a new empty %s without removing first/even-page variants', (field) => {
    const snapshot = richSnapshot()
    const key = field === 'headerHtml' ? 'defaultHeaderId' : 'defaultFooterId'
    const part = field === 'headerHtml' ? 'headers' : 'footers'
    delete snapshot[part]![snapshot.documentStyle[key]!]
    delete snapshot.documentStyle[key]
    const draft = createWordHeaderFooterDraft(snapshot, field)
    expect(draft.snapshot.body!.dataStream).toBe('\r\n')
    const edited = htmlToUniverSnapshot('<p>New text</p>', draft.snapshot.id, '')
    const merged = mergeWordHeaderFooterDraft(snapshot, draft, edited)
    expect(merged[part]![draft.segmentId]!.body.dataStream).toBe('New text\r\n')
    for (const [id, value] of Object.entries(snapshot[part]!)) expect(merged[part]![id]).toEqual(value)
  })

  it('rejects stale edits and missing resources instead of overwriting live data', () => {
    const snapshot = richSnapshot()
    const draft = createWordHeaderFooterDraft(snapshot, 'headerHtml')
    const current = structuredClone(snapshot)
    current.headers![draft.segmentId]!.body.dataStream = 'Concurrent header\r\n'
    expect(() => mergeWordHeaderFooterDraft(current, draft, draft.snapshot)).toThrow('changed while')
    const invalid = structuredClone(draft.snapshot)
    invalid.drawings = {}
    expect(() => mergeWordHeaderFooterDraft(snapshot, draft, invalid)).toThrow('missing drawings')
    expect(snapshot).toEqual(draft.original)
  })

  it('normalizes only a missing side, not native text/formatting on the existing side', () => {
    const snapshot = richSnapshot()
    snapshot.footers = {}
    delete snapshot.documentStyle.defaultFooterId
    const normalized = normalizeUniverDocumentSnapshot(snapshot, snapshot.id, 'Report', page, settings)
    expect(normalized.headers).toEqual(snapshot.headers)
    expect(normalized.drawings).toEqual(snapshot.drawings)
    expect(normalized.footers!['bridgic-word-footer']!.body.dataStream).toBe('Old footer\r\n')
    delete snapshot.headers!['bridgic-word-header']
    delete snapshot.documentStyle.defaultHeaderId
    expect(normalizeUniverDocumentSnapshot(snapshot, snapshot.id, 'Report', page, settings).headers).toEqual(snapshot.headers)
  })

  it('exports the referenced default, first and even-page parts, not the first map entry', async () => {
    const snapshot = richSnapshot()
    snapshot.headers = { first: snapshot.headers!['first']!, even: snapshot.headers!['even']!, 'bridgic-word-header': snapshot.headers!['bridgic-word-header']! }
    snapshot.documentStyle.useFirstPageHeaderFooter = BooleanNumber.TRUE
    snapshot.documentStyle.evenAndOddHeaders = BooleanNumber.TRUE
    snapshot.documentStyle.marginHeader = 22
    snapshot.documentStyle.marginFooter = 44
    const document = { ...createWordWorkspace('variants-export', 'Report').documents[0]!, id: snapshot.id, snapshot, headerFooter: settings }
    const zip = await JSZip.loadAsync(await exportWordDocx(document))
    const xml = await zip.file('word/document.xml')!.async('text')
    expect(await zip.file('word/header.xml')!.async('text')).toContain('Company')
    expect(await zip.file('word/header-first.xml')!.async('text')).toContain('First header')
    expect(await zip.file('word/header-even.xml')!.async('text')).toContain('Even header')
    expect(await zip.file('word/footer-first.xml')!.async('text')).toContain('First footer')
    expect(xml).toContain('<w:titlePg/>')
    expect(xml).toContain('w:type="first"')
    expect(xml).toContain('w:type="even"')
    expect(xml).toContain('w:header="330" w:footer="660"')
    expect(await zip.file('word/settings.xml')!.async('text')).toContain('<w:evenAndOddHeaders/>')
    expect(zip.file('word/_rels/header-first.xml.rels')).not.toBeNull()
    const imported = await importDocxToHtml(await zip.generateAsync({ type: 'uint8array' }))
    expect(imported.layout!.headerFooter.headerHtml).toContain('Company')
    expect(imported.document!.snapshot.headers).toEqual(snapshot.headers)
  })

  it('exports native list glyphs and starting numbers instead of resetting them to plain decimals', async () => {
    const snapshot = richSnapshot()
    const bullet = snapshot.headers!['bridgic-word-header']!.body.paragraphs!.find((p) => p.bullet)!.bullet!
    snapshot.lists![bullet.listType] = structuredClone(PRESET_LIST_TYPE[bullet.listType]!)
    const level = snapshot.lists![bullet.listType]!.nestingLevel[0]!
    level.glyphType = ListGlyphType.UPPER_ROMAN
    level.startNumber = 3
    level.glyphFormat = '%1)'
    const document = { ...createWordWorkspace('numbering-export', 'Report').documents[0]!, snapshot, headerFooter: settings }
    const zip = await JSZip.loadAsync(await exportWordDocx(document))
    const xml = await zip.file('word/numbering.xml')!.async('text')
    expect(xml).toContain('<w:start w:val="4"/>')
    expect(xml).toContain('<w:numFmt w:val="upperRoman"/>')
    expect(xml).toContain('<w:lvlText w:val="%1)"/>')
  })
})
