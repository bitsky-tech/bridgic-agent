import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { BooleanNumber, CustomRangeType, DocumentDataModel, LocaleService, PageOrientType, SectionType } from '@univerjs/core'
import { DocumentSkeleton, DocumentViewModel } from '@univerjs/engine-render'
import { resolve } from 'node:path'
import JSZip from 'jszip'

GlobalRegistrator.register()
const { importDocxToHtml } = await import('../wordDocxImport')
const { importDocxInBackground } = await import('../wordImport')
const { createEmptyWordWorkspace, createWordDomainStore } = await import('../wordDomain')
const { exportWordDocx } = await import('../wordDocxExport')
const { createWordHeaderFooterDraft, mergeWordHeaderFooterDraft } = await import('../wordHeaderFooter')
const { htmlToUniverSnapshot } = await import('../wordUniverModel')

const originalWorker = globalThis.Worker
class InlineWordImportWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage(bytes: Uint8Array) {
    // Exercise the real decoder and renderer initialization across the worker boundary.
    void importDocxToHtml(bytes).then(
      (value) => this.onmessage?.({ data: { ok: true, value } } as MessageEvent),
      (error) => this.onmessage?.({ data: { ok: false, error: String(error) } } as MessageEvent),
    )
  }
  terminate() {}
}
beforeEach(() => { globalThis.Worker = InlineWordImportWorker as unknown as typeof Worker })
afterEach(() => { globalThis.Worker = originalWorker })
afterAll(async () => GlobalRegistrator.unregister())

async function externalDocument(options: { onlyFirst?: boolean; emptyFirst?: boolean } = {}) {
  const base = resolve(import.meta.dir, '../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
  const archive = await JSZip.loadAsync(await Bun.file(base).arrayBuffer())
  const parts = (['header', 'footer'] as const).flatMap((kind) =>
    (['default', 'first', 'even'] as const).filter((variant) => !options.onlyFirst || variant === 'first').map((variant) => ({ kind, variant, id: `${kind}-${variant}` })))
  archive.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Report body</w:t></w:r></w:p><w:sectPr>${parts.map(({ kind, variant, id }) => `<w:${kind}Reference w:type="${variant}" r:id="${id}"/>`).join('')}<w:titlePg/><w:pgNumType w:start="3"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
  archive.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.map(({ kind, id }) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="parts/${id}.xml"/>`).join('')}<Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`)
  archive.file('word/settings.xml', '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:evenAndOddHeaders/></w:settings>')
  const image = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1371600" cy="342900"/><wp:docPr id="1" name="Logo"/><a:graphic><a:graphicData><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Logo"/></pic:nvPicPr><pic:blipFill><a:blip r:embed="logo"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  for (const { kind, variant, id } of parts) {
    const tag = kind === 'header' ? 'hdr' : 'ftr'
    const empty = options.emptyFirst && variant === 'first'
    const rich = variant === 'first' && !empty
    archive.file(`word/parts/${id}.xml`, `<w:${tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:p>${empty ? '' : `<w:r><w:rPr><w:b/></w:rPr><w:t>${id}</w:t></w:r>`}</w:p>${rich ? `${image}<w:p><w:hyperlink r:id="website"><w:r><w:t>${id} link</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>${id} table</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` : ''}</w:${tag}>`)
    if (rich) archive.file(`word/parts/_rels/${id}.xml.rels`, '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="logo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/><Relationship Id="website" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>')
  }
  archive.file('word/media/logo.png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6T4cAAAAASUVORK5CYII=', { base64: true })
  return archive.generateAsync({ type: 'uint8array' })
}

async function sectionedDocument(changed: boolean) {
  const archive = await JSZip.loadAsync(await externalDocument())
  const references = (['header', 'footer'] as const).flatMap((kind) => (['default', 'first', 'even'] as const).map((variant) => `<w:${kind}Reference w:type="${variant}" r:id="${kind}-${variant}"/>`)).join('')
  const section = (refs: string, first: boolean) => `<w:sectPr>${refs}${first ? '<w:titlePg/>' : ''}<w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`
  const secondRefs = changed ? '<w:headerReference w:type="default" r:id="alternate"/><w:footerReference w:type="first" r:id="empty"/>' : ''
  archive.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr>${section(references, true)}</w:pPr><w:r><w:t>Section one</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Body table</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:pPr>${section(secondRefs, true)}</w:pPr><w:r><w:t>Section two</w:t></w:r></w:p><w:p><w:r><w:t>Section three</w:t></w:r></w:p>${section('', false)}</w:body></w:document>`)
  if (changed) {
    const rels = await archive.file('word/_rels/document.xml.rels')!.async('text')
    archive.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', '<Relationship Id="alternate" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="parts/alternate.xml"/><Relationship Id="empty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="parts/empty.xml"/></Relationships>'))
    archive.file('word/parts/alternate.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Second chapter header</w:t></w:r></w:p></w:hdr>')
    archive.file('word/parts/empty.xml', '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:ftr>')
  }
  return archive.generateAsync({ type: 'uint8array' })
}

describe('Word import native initialization', () => {
  it.each(['Arabic', 'roman', 'ROMAN', 'alphabetic', 'ALPHABETIC'].flatMap((format) => [false, true].map((sectionFormat) => [format, sectionFormat] as const)))('keeps live PAGE/NUMPAGES fields through layout, native edits and external reopen (%s, section-format=%s)', async (format, sectionFormat) => {
    const source = await JSZip.loadAsync(await externalDocument())
    const paragraphs = '<w:p><w:r><w:t>Report paragraph</w:t></w:r></w:p>'.repeat(35)
    source.file('word/settings.xml', '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>')
    const nativeFormat = ({ Arabic: 'decimal', roman: 'lowerRoman', ROMAN: 'upperRoman', alphabetic: 'lowerLetter', ALPHABETIC: 'upperLetter' } as Record<string, string>)[format]!
    source.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs}<w:sectPr><w:footerReference w:type="default" r:id="footer-default"/><w:pgNumType w:start="9"${sectionFormat ? ` w:fmt="${nativeFormat}"` : ''}/><w:pgSz w:w="6000" w:h="3600"/><w:pgMar w:top="360" w:bottom="360" w:left="360" w:right="360" w:footer="120"/></w:sectPr></w:body></w:document>`)
    const instruction = sectionFormat ? 'PAGE' : `PAGE \\* ${format}`
    source.file('word/parts/footer-default.xml', `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PA</w:instrText></w:r><w:r><w:instrText>${instruction.slice(2)}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>99</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t> of </w:t></w:r><w:fldSimple w:instr="NUMPAGES"><w:r><w:t>99</w:t></w:r></w:fldSimple></w:p></w:ftr>`)
    let bytes = await source.generateAsync({ type: 'uint8array' })
    for (let cycle = 0; cycle < 2; cycle++) {
      const imported = await importDocxInBackground(bytes)
      expect(imported.warnings).toEqual([])
      const store = createWordDomainStore(createEmptyWordWorkspace(`fields-${format}-${cycle}`), { defaultTitle: 'Report' })
      try {
        expect((await store.dispatch({ type: 'document.open', ...imported, title: 'Report.docx', sourcePath: '/Report.docx', sourceMtimeMs: cycle + 1 })).ok).toBe(true)
        const document = store.getSnapshot().documents[0]!
        const draft = createWordHeaderFooterDraft(document.snapshot, 'footerHtml')
        // Edit surrounding text with native field ranges, not a flattened HTML draft.
        const edited = structuredClone(draft.snapshot)
        edited.body!.dataStream = edited.body!.dataStream.replace('Page', 'PAGE')
        expect(store.commitEditorSnapshot(document.id, mergeWordHeaderFooterDraft(document.snapshot, draft, edited))).toBe(true)
        const current = store.getSnapshot().documents[0]!
        const model = new DocumentDataModel(current.snapshot)
        const locale = new LocaleService()
        const skeleton = new DocumentSkeleton(new DocumentViewModel(model), locale)
        try {
          skeleton.calculate()
          const pages = skeleton.getSkeletonData()!.pages
          expect(pages.length).toBeGreaterThan(2)
          const footerBody = current.snapshot.footers![pages[0]!.footerId]!.body
          expect(footerBody.dataStream).toBe('PAGE \uFFFC of \uFFFC\r\n')
          expect(footerBody.customRanges?.map((field) => field.properties?.field)).toEqual(['PAGE', 'NUMPAGES'])
          const formatNumber = (number: number) => {
            if (format === 'Arabic') return String(number)
            if (format.toLowerCase() === 'alphabetic') return String.fromCharCode((format === 'alphabetic' ? 97 : 65) + number - 1)
            const roman = ['IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI'][number - 9]!
            return format === 'roman' ? roman.toLowerCase() : roman
          }
          for (const page of pages) {
            const glyphs = page.footerSkeleton!.sections.flatMap((section) => section.columns.flatMap((column) => column.lines.flatMap((line) => line.divides.flatMap((divide) => divide.glyphGroup))))
            expect(glyphs.map((glyph) => glyph.content).join('').trim()).toBe(`PAGE ${formatNumber(page.pageNumber)} of ${pages.length}`)
            const field = glyphs.find((glyph) => glyph.raw === '\uFFFC')!
            expect(field.count).toBe(1)
            expect(field.ts?.bl).toBe(BooleanNumber.TRUE)
            expect(field.ts?.cl?.rgb).not.toBe('#274fee')
            expect(page.footerId).toBe(pages[0]!.footerId)
          }
          skeleton.makeDirty(true)
          skeleton.calculate()
          expect(skeleton.getSkeletonData()!.pages).toHaveLength(pages.length)
          expect(current.snapshot.footers![pages[0]!.footerId]!.body).toEqual(footerBody)
        } finally { skeleton.dispose(); model.dispose(); locale.dispose() }
        const archive = await JSZip.loadAsync(await exportWordDocx(current))
        const footer = await archive.file('word/footer.xml')!.async('text')
        expect(footer).toContain(`w:instr="${instruction}"`)
        expect(footer).toContain('w:instr="NUMPAGES"')
        expect(footer.match(/w:dirty="true"/g)).toHaveLength(2)
        if (sectionFormat) expect(await archive.file('word/document.xml')!.async('text')).toContain(`w:fmt="${nativeFormat}"`)
        expect(footer).not.toContain('\uFFFC')
        archive.remove('bridgic/editor-model.json')
        bytes = await archive.generateAsync({ type: 'uint8array' })
      } finally { store.dispose() }
    }
  })

  it.each(['vml', 'alternate', 'ignored-drawing'])('associates image dimensions by source instance, not conversion order (%s)', async (mode) => {
    const source = await JSZip.loadAsync(await externalDocument())
    const image = (name: string, width: number, height: number) => `<w:drawing><wp:inline><wp:extent cx="${width * 9525}" cy="${height * 9525}"/><wp:docPr id="1" name="${name}" descr="${name}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="logo"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
    const vml = '<w:pict><v:shape style="width:60pt;height:15pt"><v:imagedata r:id="logo" o:title="Legacy logo"/></v:shape></w:pict>'
    let first = vml
    if (mode === 'alternate') first = `<mc:AlternateContent><mc:Choice Requires="pic">${image('Ignored choice', 500, 400)}</mc:Choice><mc:Fallback>${vml}</mc:Fallback></mc:AlternateContent>`
    if (mode === 'ignored-drawing') first = '<w:drawing><wp:inline><wp:extent cx="4762500" cy="3810000"/><a:graphic><a:graphicData/></a:graphic></wp:inline></w:drawing>'
    const namespaces = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
    source.file('word/document.xml', `<w:document ${namespaces}><w:body><w:p><w:r>${first}</w:r></w:p><w:p><w:r>${image('Modern image', 240, 120)}</w:r></w:p><w:p><w:r>${image('Repeated image', 120, 60)}</w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="header-default"/></w:sectPr></w:body></w:document>`)
    source.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="logo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/><Relationship Id="header-default" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="parts/header-default.xml"/></Relationships>')
    source.file('word/parts/header-default.xml', `<w:hdr ${namespaces}><w:p><w:r>${first}</w:r></w:p><w:p><w:r>${image('Header image', 150, 30)}</w:r></w:p></w:hdr>`)
    source.file('word/parts/_rels/header-default.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="logo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/></Relationships>')
    let bytes = await source.generateAsync({ type: 'uint8array' })
    for (let cycle = 0; cycle < 2; cycle++) {
      const imported = await importDocxInBackground(bytes)
      expect(imported.html).not.toContain('bridgic-word-import-')
      const snapshot = imported.document!.snapshot
      const drawings = Object.values(snapshot.drawings!)
      for (const [name, width, height] of [['Modern image', 240, 120], ['Repeated image', 120, 60], ['Header image', 150, 30]] as const) {
        expect(drawings.find((drawing) => drawing.description === name)?.docTransform.size).toEqual({ width, height })
      }
      if (mode !== 'ignored-drawing') {
        const legacy = drawings.filter((drawing) => drawing.description === 'Legacy logo')
        expect(legacy).toHaveLength(2)
        expect(legacy.every((drawing) => drawing.docTransform.size.width === 80 && drawing.docTransform.size.height === 20)).toBe(true)
      }
      expect(drawings.some((drawing) => drawing.description === 'Ignored choice')).toBe(false)
      const store = createWordDomainStore(createEmptyWordWorkspace(`images-${mode}-${cycle}`), { defaultTitle: 'Report' })
      try {
        expect((await store.dispatch({ type: 'document.open', ...imported, title: 'Images.docx', sourcePath: '/Images.docx', sourceMtimeMs: cycle + 1 })).ok).toBe(true)
        const archive = await JSZip.loadAsync(await exportWordDocx(store.getSnapshot().documents[0]!))
        archive.remove('bridgic/editor-model.json')
        bytes = await archive.generateAsync({ type: 'uint8array' })
      } finally { store.dispose() }
    }
  })

  it.each([
    ['oddPage', SectionType.ODD_PAGE, 1, 3, 'header-default'],
    ['evenPage', SectionType.EVEN_PAGE, 45, 4, 'header-even'],
  ] as const)('keeps %s section pagination and headers through an external file cycle', async (type, sectionType, count, pageCount, header) => {
    const source = await JSZip.loadAsync(await externalDocument())
    const first = '<w:sectPr><w:headerReference w:type="default" r:id="header-default"/><w:headerReference w:type="even" r:id="header-even"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:bottom="720" w:left="720" w:right="720"/></w:sectPr>'
    const paragraphs = Array.from({ length: count }, (_, index) => `<w:p>${index === count - 1 ? `<w:pPr>${first}</w:pPr>` : ''}<w:r><w:t>Chapter one paragraph ${index + 1}</w:t></w:r></w:p>`).join('')
    source.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs}<w:p><w:r><w:t>Chapter two</w:t></w:r></w:p><w:sectPr><w:type w:val="${type}"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
    let bytes = await source.generateAsync({ type: 'uint8array' })
    for (let cycle = 0; cycle < 2; cycle++) {
      const imported = await importDocxInBackground(bytes)
      const store = createWordDomainStore(createEmptyWordWorkspace(`parity-${type}-${cycle}`), { defaultTitle: 'Report' })
      try {
        await store.dispatch({ type: 'document.open', ...imported, title: 'Chapters.docx', sourcePath: '/Chapters.docx', sourceMtimeMs: cycle + 1 })
        const document = store.getSnapshot().documents[0]!
        const breaks = document.snapshot.body!.sectionBreaks!
        expect(breaks[1]!.sectionType).toBe(sectionType)
        const model = new DocumentDataModel(document.snapshot)
        const locale = new LocaleService()
        const skeleton = new DocumentSkeleton(new DocumentViewModel(model), locale)
        try {
          skeleton.calculate()
          const pages = skeleton.getSkeletonData()!.pages
          expect(pages).toHaveLength(pageCount)
          expect(pages.at(-2)!.sections).toHaveLength(0)
          expect(pages.at(-1)!.pageNumber).toBe(pageCount)
          expect(pages.at(-1)!.st).toBe(breaks[0]!.startIndex + 1)
          expect(document.snapshot.headers![pages.at(-1)!.headerId!]!.body.dataStream).toContain(header)
        } finally { skeleton.dispose(); model.dispose(); locale.dispose() }
        const archive = await JSZip.loadAsync(await exportWordDocx(document))
        expect(await archive.file('word/document.xml')!.async('text')).toContain(`<w:type w:val="${type}"/>`)
        archive.remove('bridgic/editor-model.json')
        bytes = await archive.generateAsync({ type: 'uint8array' })
      } finally { store.dispose() }
    }
  })

  it.each([false, true])('preserves mixed section geometry through edits, rendering and external save/reopen (landscape-first=%s)', async (landscapeFirst) => {
    const source = await JSZip.loadAsync(await externalDocument())
    const geometry = [
      { width: 11906, height: 16838, orient: PageOrientType.PORTRAIT, top: 720, bottom: 840, left: 960, right: 1080 },
      { width: 15840, height: 12240, orient: PageOrientType.LANDSCAPE, top: 1440, bottom: 1560, left: 1680, right: 1800 },
      { width: 11906, height: 16838, orient: PageOrientType.PORTRAIT, top: 0, bottom: 1200, left: 1320, right: 1440 },
    ]
    // Exercise both orientations as the document default.
    if (landscapeFirst) [geometry[0], geometry[1]] = [geometry[1]!, geometry[0]!]
    const sectionXml = geometry.map((size, index) => `<w:sectPr>${index === 0 ? '<w:headerReference w:type="default" r:id="header-default"/>' : ''}<w:pgSz w:w="${size.width}" w:h="${size.height}"${size.orient === PageOrientType.LANDSCAPE ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${size.top}" w:bottom="${size.bottom}" w:left="${size.left}" w:right="${size.right}" w:header="360" w:footer="360"/></w:sectPr>`)
    const body = geometry.map((_, index) => `<w:p>${index < 2 ? `<w:pPr>${sectionXml[index]}</w:pPr>` : ''}<w:r><w:t>Chapter ${index + 1}</w:t></w:r></w:p>`).join('')
    source.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}${sectionXml[2]}</w:body></w:document>`)
    let bytes = await source.generateAsync({ type: 'uint8array' })
    for (let cycle = 0; cycle < 3; cycle++) {
      const imported = await importDocxInBackground(bytes)
      expect(imported.warnings).toEqual([])
      const store = createWordDomainStore(createEmptyWordWorkspace(`geometry-${landscapeFirst}-${cycle}`), { defaultTitle: 'Report' })
      try {
        expect((await store.dispatch({ type: 'document.open', ...imported, title: 'Mixed.docx', sourcePath: '/Mixed.docx', sourceMtimeMs: cycle + 1 })).ok).toBe(true)
        await store.dispatch({ type: 'document.append', text: 'Body correction' })
        const document = store.getSnapshot().documents[0]!
        const sections = document.snapshot.body!.sectionBreaks!
        expect(sections).toHaveLength(3)
        const model = new DocumentDataModel(document.snapshot)
        const locale = new LocaleService()
        const skeleton = new DocumentSkeleton(new DocumentViewModel(model), locale)
        try {
          skeleton.calculate()
          const pages = skeleton.getSkeletonData()!.pages
          expect(pages).toHaveLength(3)
          for (const [index, size] of geometry.entries()) {
            expect(sections[index]).toMatchObject({
              pageSize: { width: size.width / 15, height: size.height / 15 }, pageOrient: size.orient,
              marginTop: size.top / 15, marginBottom: size.bottom / 15, marginLeft: size.left / 15, marginRight: size.right / 15,
            })
            expect(pages[index]).toMatchObject({ pageWidth: size.width / 15, pageHeight: size.height / 15, marginLeft: size.left / 15, marginRight: size.right / 15 })
          }
        } finally { skeleton.dispose(); model.dispose(); locale.dispose() }
        const archive = await JSZip.loadAsync(await exportWordDocx(document))
        const xml = await archive.file('word/document.xml')!.async('text')
        expect([...(xml.match(/<w:pgSz[^>]*\/>/g) ?? [])]).toEqual(geometry.map((size) => `<w:pgSz w:w="${size.width}" w:h="${size.height}"${size.orient === PageOrientType.LANDSCAPE ? ' w:orient="landscape"' : ''}/>`))
        const exportedMargins = xml.match(/<w:pgMar[^>]*\/>/g)!
        for (const [index, size] of geometry.entries()) for (const field of ['top', 'bottom', 'left', 'right'] as const) expect(exportedMargins[index]).toContain(`w:${field}="${size[field]}"`)
        archive.remove('bridgic/editor-model.json')
        bytes = await archive.generateAsync({ type: 'uint8array' })
        // Changing one Ribbon setting must leave unrelated section layout intact.
        await store.dispatch({ type: 'document.page.update', page: { margins: 'wide' } })
        let updated = store.getSnapshot().documents[0]!.snapshot.body!.sectionBreaks!
        expect(updated.map((item) => item.pageSize)).toEqual(sections.map((item) => item.pageSize))
        expect(updated.map((item) => item.pageOrient)).toEqual(geometry.map((size) => size.orient))
        expect(updated.every((item) => item.marginLeft === 96)).toBe(true)
        await store.dispatch({ type: 'document.page.update', page: { orientation: 'landscape' } })
        updated = store.getSnapshot().documents[0]!.snapshot.body!.sectionBreaks!
        expect(updated.every((item) => item.pageOrient === PageOrientType.LANDSCAPE && item.pageSize!.width! > item.pageSize!.height!)).toBe(true)
        expect(updated.every((item) => item.marginLeft === 96)).toBe(true)
      } finally { store.dispose() }
    }
  })

  it('keeps a headerless cover section blank when later sections have headers through external reopen', async () => {
    const source = await JSZip.loadAsync(await sectionedDocument(false))
    let xml = await source.file('word/document.xml')!.async('text')
    const sections = xml.match(/<w:sectPr>[\s\S]*?<\/w:sectPr>/g)!
    const size = '<w:pgSz w:w="11906" w:h="16838"/>'
    xml = xml.replace(sections[0]!, `<w:sectPr>${size}</w:sectPr>`).replace(sections[1]!, `<w:sectPr><w:headerReference w:type="default" r:id="header-default"/><w:footerReference w:type="default" r:id="footer-default"/>${size}</w:sectPr>`)
    source.file('word/document.xml', xml)
    let bytes = await source.generateAsync({ type: 'uint8array' })
    for (let cycle = 0; cycle < 3; cycle++) {
      const imported = await importDocxInBackground(bytes)
      const { snapshot } = imported.document!
      const breaks = snapshot.body!.sectionBreaks!.filter((item) => item.defaultHeaderId !== undefined)
      expect(breaks).toHaveLength(3)
      expect(breaks[0]).toMatchObject({ defaultHeaderId: '', defaultFooterId: '' })
      expect(snapshot.headers![breaks[1]!.defaultHeaderId!]!.body.dataStream).toContain('header-default')
      expect(snapshot.footers![breaks[1]!.defaultFooterId!]!.body.dataStream).toContain('footer-default')
      const store = createWordDomainStore(createEmptyWordWorkspace(`cover-${cycle}`), { defaultTitle: 'Report' })
      try {
        await store.dispatch({ type: 'document.open', ...imported, title: 'Cover.docx', sourcePath: '/Cover.docx', sourceMtimeMs: cycle + 1 })
        const archive = await JSZip.loadAsync(await exportWordDocx(store.getSnapshot().documents[0]!))
        const exported = await archive.file('word/document.xml')!.async('text')
        expect(exported.match(/<w:sectPr>[\s\S]*?<\/w:sectPr>/g)![0]).not.toContain('Reference')
        archive.remove('bridgic/editor-model.json')
        bytes = await archive.generateAsync({ type: 'uint8array' })
      } finally { store.dispose() }
    }
  })

  it.each([false, true])('keeps per-section parts, inheritance and explicit blank overrides through native edits and external reopen (changed=%s)', async (changed) => {
    let bytes = await sectionedDocument(changed)
    for (let cycle = 0; cycle < 3; cycle++) {
      const imported = await importDocxInBackground(bytes)
      expect(imported.warnings).toEqual([])
      expect(imported.html).not.toContain('bridgic-word-section-')
      const store = createWordDomainStore(createEmptyWordWorkspace(`sections-${changed}-${cycle}`), { defaultTitle: 'Report' })
      try {
        expect((await store.dispatch({ type: 'document.open', ...imported, title: 'Sections.docx', sourcePath: '/Sections.docx', sourceMtimeMs: cycle + 1 })).ok).toBe(true)
        const document = store.getSnapshot().documents[0]!
        const { snapshot } = document
        const sections = snapshot.body!.sectionBreaks!.filter((item) => item.defaultHeaderId !== undefined)
        expect(sections).toHaveLength(3)
        expect(sections.map((item) => item.useFirstPageHeaderFooter)).toEqual([1, 1, 0])
        for (const section of sections) {
          expect(snapshot.body!.dataStream[section.startIndex]).toBe('\n')
          expect(section.evenAndOddHeaders).toBe(1)
          expect(snapshot.footers![section.defaultFooterId!]!.body.dataStream).toContain('footer-default')
          expect(snapshot.headers![section.firstPageHeaderId!]!.body.dataStream).toContain('header-first')
          expect(snapshot.headers![section.evenPageHeaderId!]!.body.dataStream).toContain('header-even')
        }
        expect(sections[2]!.defaultHeaderId).toBe(sections[1]!.defaultHeaderId)
        expect(sections[2]!.firstPageFooterId).toBe(sections[1]!.firstPageFooterId)
        expect(snapshot.headers![sections[0]!.defaultHeaderId!]!.body.dataStream).toContain('header-default')
        if (changed) {
          expect(sections[1]!.defaultHeaderId).not.toBe(sections[0]!.defaultHeaderId)
          expect(snapshot.headers![sections[1]!.defaultHeaderId!]!.body.dataStream).toContain('Second chapter header')
          expect(snapshot.footers![sections[1]!.firstPageFooterId!]!.body.dataStream).toBe('\r\n')
        } else expect(sections.map((item) => item.defaultHeaderId)).toEqual(Array(3).fill(sections[0]!.defaultHeaderId))
        expect(Object.keys(snapshot.drawings!)).toHaveLength(2)
        expect(snapshot.body!.tables).toHaveLength(1)
        expect(Object.keys(snapshot.tableSource!)).toHaveLength(3)
        const draft = createWordHeaderFooterDraft(snapshot, 'footerHtml')
        const edited = htmlToUniverSnapshot('<p>footer-default edited</p>', draft.snapshot.id, '')
        expect(store.commitEditorSnapshot(document.id, mergeWordHeaderFooterDraft(snapshot, draft, edited))).toBe(true)
        await store.dispatch({ type: 'document.append', text: 'Body edit' })
        const archive = await JSZip.loadAsync(await exportWordDocx(store.getSnapshot().documents[0]!))
        const xml = await archive.file('word/document.xml')!.async('text')
        expect(xml.match(/<w:sectPr>/g)).toHaveLength(3)
        expect(xml).toContain('Body table')
        archive.remove('bridgic/editor-model.json')
        bytes = await archive.generateAsync({ type: 'uint8array' })
      } finally { store.dispose() }
    }
  })

  it('retains all six rich parts, flags and isolated assets through edits and two external save/reopen cycles', async () => {
    let bytes = await externalDocument()
    for (let cycle = 0; cycle < 3; cycle++) {
      const imported = await importDocxInBackground(bytes)
      expect(imported.sourceProtected).toBe(true)
      expect(imported.warnings).toEqual([])
      const store = createWordDomainStore(createEmptyWordWorkspace(`variant-import-${cycle}`), { defaultTitle: 'Report' })
      try {
        expect((await store.dispatch({ type: 'document.open', ...imported, title: 'Report.docx', sourcePath: '/Report.docx', sourceMtimeMs: cycle + 1 })).ok).toBe(true)
        const document = store.getSnapshot().documents[0]!
        const { snapshot } = document
        expect(snapshot.documentStyle).toMatchObject({ useFirstPageHeaderFooter: BooleanNumber.TRUE, evenAndOddHeaders: BooleanNumber.TRUE, pageNumberStart: 3 })
        expect(document.headerFooter.differentFirstPage).toBe(true)
        expect(Object.keys(snapshot.headers!)).toHaveLength(3)
        expect(Object.keys(snapshot.footers!)).toHaveLength(3)
        for (const kind of ['header', 'footer'] as const) {
          const parts = kind === 'header' ? snapshot.headers! : snapshot.footers!
          const ids = kind === 'header'
            ? [snapshot.documentStyle.defaultHeaderId, snapshot.documentStyle.firstPageHeaderId, snapshot.documentStyle.evenPageHeaderId]
            : [snapshot.documentStyle.defaultFooterId, snapshot.documentStyle.firstPageFooterId, snapshot.documentStyle.evenPageFooterId]
          for (const [index, variant] of ['default', 'first', 'even'].entries()) {
            const body = parts[ids[index]!]!.body
            expect(body.dataStream).toContain(`${kind}-${variant}`)
            expect(body.textRuns!.some((run) => run.ts?.bl === BooleanNumber.TRUE)).toBe(true)
            if (variant !== 'first') continue
            expect(body.tables).toHaveLength(1)
            expect(body.customBlocks).toHaveLength(1)
            const drawing = snapshot.drawings![body.customBlocks![0]!.blockId]!
            expect(drawing.docTransform.size).toEqual({ width: 144, height: 36 })
            expect(drawing.unitId).toBe(document.id)
            expect(body.customRanges!.find((range) => range.rangeType === CustomRangeType.HYPERLINK)?.properties?.url).toBe('https://example.com/')
          }
        }
        expect(Object.keys(snapshot.drawings!)).toHaveLength(2)
        expect(Object.keys(snapshot.tableSource!)).toHaveLength(2)
        const links = [...Object.values(snapshot.headers!), ...Object.values(snapshot.footers!)].flatMap((part) => part.body.customRanges ?? [])
        expect(new Set(links.map((range) => range.rangeId)).size).toBe(2)
        await store.dispatch({ type: 'document.append', text: `Body correction ${cycle}` })
        expect(store.getSnapshot().documents[0]!.snapshot.headers).toEqual(snapshot.headers)
        expect(store.getSnapshot().documents[0]!.snapshot.footers).toEqual(snapshot.footers)
        const archive = await JSZip.loadAsync(await exportWordDocx(store.getSnapshot().documents[0]!))
        const xml = await archive.file('word/document.xml')!.async('text')
        for (const kind of ['header', 'footer']) for (const type of ['default', 'first', 'even']) expect(xml).toContain(`<w:${kind}Reference w:type="${type}"`)
        expect(xml).toContain('<w:titlePg/>')
        expect(await archive.file('word/settings.xml')!.async('text')).toContain('<w:evenAndOddHeaders/>')
        archive.remove('bridgic/editor-model.json')
        bytes = await archive.generateAsync({ type: 'uint8array' })
      } finally { store.dispose() }
    }
  })

  it.each([false, true])('keeps explicit empty first-page parts without inventing a default (first-only=%s)', async (onlyFirst) => {
    const imported = await importDocxInBackground(await externalDocument({ onlyFirst, emptyFirst: true }))
    const { snapshot } = imported.document!
    for (const kind of ['header', 'footer'] as const) {
      const parts = kind === 'header' ? snapshot.headers! : snapshot.footers!
      const id = kind === 'header' ? snapshot.documentStyle.firstPageHeaderId : snapshot.documentStyle.firstPageFooterId
      expect(parts[id!]!.body.dataStream).toBe('\r\n')
      if (onlyFirst) {
        expect(Object.keys(parts)).toEqual([id!])
        expect(kind === 'header' ? snapshot.documentStyle.defaultHeaderId : snapshot.documentStyle.defaultFooterId).toBe('')
      }
    }
    const store = createWordDomainStore(createEmptyWordWorkspace('empty-first-parts'), { defaultTitle: 'Report' })
    try {
      await store.dispatch({ type: 'document.open', ...imported, title: 'Report.docx', sourcePath: '/Report.docx', sourceMtimeMs: 1 })
      const archive = await JSZip.loadAsync(await exportWordDocx(store.getSnapshot().documents[0]!))
      const xml = await archive.file('word/document.xml')!.async('text')
      expect(xml.includes('Reference w:type="default"')).toBe(!onlyFirst)
      expect(xml).toContain('headerReference w:type="first"')
      expect(xml).toContain('footerReference w:type="first"')
    } finally { store.dispose() }
  })
})
