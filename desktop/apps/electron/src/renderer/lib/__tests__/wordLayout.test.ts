import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { BooleanNumber, DocumentDataModel, LocaleService, SectionType } from '@univerjs/core'
import { DocumentSkeleton, DocumentViewModel, startWithEmoji } from '@univerjs/engine-render'
import { appendTextBlockToSnapshot, createUniverSectionedDocumentSnapshot, htmlToUniverSnapshot } from '../wordUniverModel'

GlobalRegistrator.register()
afterAll(async () => { await GlobalRegistrator.unregister() })

describe('Word native layout memory sharing', () => {
  it('renders a shared PAGE footer with distinct section formats and unchanged field indexes', () => {
    const footer = { kind: 'footer' as const, variant: 'default' as const, id: 'shared-footer', html: '<p>Page <span data-word-field="PAGE">1</span></p>' }
    const snapshot = createUniverSectionedDocumentSnapshot('shared-fields', 'Sections', { size: 'a4', orientation: 'portrait', margins: 'normal' }, {
      headerHtml: '', footerHtml: '', showPageNumbers: false, differentFirstPage: false, pageNumberStart: 1,
    }, ['lowerRoman', 'decimal'].map((pageNumberFormat) => ({ html: '<p>Chapter</p>', style: {
      pageNumberFormat: pageNumberFormat as 'lowerRoman' | 'decimal', pageNumberStart: 1, defaultFooterId: footer.id, sectionType: SectionType.NEXT_PAGE,
    }, parts: [footer] })))
    const model = new DocumentDataModel(snapshot)
    const locale = new LocaleService()
    const skeleton = new DocumentSkeleton(new DocumentViewModel(model), locale)
    try {
      skeleton.calculate()
      const pages = skeleton.getSkeletonData()!.pages
      expect(pages).toHaveLength(2)
      const texts = pages.map((page) => page.footerSkeleton!.sections.flatMap((section) => section.columns.flatMap((column) => column.lines.flatMap((line) => line.divides.flatMap((divide) => divide.glyphGroup.map((glyph) => glyph.content))))).join('').trim())
      expect(texts).toEqual(['Page i', 'Page 1'])
      expect(pages.map((page) => page.footerId)).toEqual([footer.id, footer.id])
      expect(pages[0]!.footerSkeleton).not.toBe(pages[1]!.footerSkeleton)
      for (let page = 0; page < 2; page++) expect(skeleton.findNodePositionByCharIndex(5, true, footer.id, page)).toBeDefined()
      expect(snapshot.footers![footer.id]!.body.dataStream).toBe('Page \uFFFC\r\n')
    } finally { skeleton.dispose(); model.dispose(); locale.dispose() }
  })

  it('recomputes total-page fields after content grows without mutating canonical field ranges', () => {
    let snapshot = createUniverSectionedDocumentSnapshot('total-fields', 'Totals', { size: 'a4', orientation: 'portrait', margins: 'normal' }, {
      headerHtml: '', footerHtml: '', showPageNumbers: false, differentFirstPage: false, pageNumberStart: 1,
    }, [{ html: '<p>Report paragraph</p>'.repeat(10), style: { defaultFooterId: 'total-footer' }, parts: [{ kind: 'footer', variant: 'default', id: 'total-footer', html: '<p>Total: <span data-word-field="NUMPAGES">1</span></p>' }] }])
    snapshot.documentStyle.pageSize = { width: 400, height: 240 }
    snapshot.documentStyle.marginTop = snapshot.documentStyle.marginBottom = 35
    let previousCount = 0
    for (let edit = 0; edit < 2; edit++) {
      const canonical = structuredClone(snapshot)
      const model = new DocumentDataModel(snapshot)
      const locale = new LocaleService()
      const skeleton = new DocumentSkeleton(new DocumentViewModel(model), locale)
      try {
        skeleton.calculate()
        const pages = skeleton.getSkeletonData()!.pages
        expect(pages.length).toBeGreaterThan(previousCount)
        previousCount = pages.length
        for (const page of pages) {
          const glyphs = page.footerSkeleton!.sections.flatMap((section) => section.columns.flatMap((column) => column.lines.flatMap((line) => line.divides.flatMap((divide) => divide.glyphGroup))))
          expect(glyphs.find((glyph) => glyph.raw === '\uFFFC')?.content).toBe(String(pages.length))
        }
        expect(snapshot).toEqual(canonical)
      } finally { skeleton.dispose(); model.dispose(); locale.dispose() }
      snapshot = appendTextBlockToSnapshot(snapshot, Array(30).fill('Added paragraph').join('\n'), 'paragraph')
    }
  })

  it.each([
    [SectionType.ODD_PAGE, 1, true], [SectionType.ODD_PAGE, 6, false],
    [SectionType.EVEN_PAGE, 1, false], [SectionType.EVEN_PAGE, 6, true],
  ] as const)('respects section parity without adding body indexes (type=%s, paragraphs=%s)', (sectionType, count, needsBlank) => {
    for (const restart of [false, true]) {
      const snapshot = createUniverSectionedDocumentSnapshot('parity', 'Chapters', { size: 'a4', orientation: 'portrait', margins: 'normal' }, {
        headerHtml: '', footerHtml: '', showPageNumbers: false, differentFirstPage: false, pageNumberStart: 1,
      }, [
        { html: '<p>First chapter</p>'.repeat(count), style: { sectionType: SectionType.NEXT_PAGE }, parts: [] },
        { html: '<p>Second chapter</p>', style: {
          sectionType, useFirstPageHeaderFooter: BooleanNumber.TRUE, firstPageHeaderId: 'chapter-first',
          ...(restart ? { pageNumberStart: 10 } : {}),
        }, parts: [{ kind: 'header', variant: 'first', id: 'chapter-first', html: '<p>Chapter opening</p>' }] },
      ])
      snapshot.documentStyle.pageSize = { width: 400, height: 240 }
      snapshot.documentStyle.marginTop = snapshot.documentStyle.marginBottom = 35
      const model = new DocumentDataModel(snapshot)
      const locale = new LocaleService()
      const skeleton = new DocumentSkeleton(new DocumentViewModel(model), locale)
      try {
        skeleton.calculate()
        const pages = skeleton.getSkeletonData()!.pages
        const start = snapshot.body!.sectionBreaks![0]!.startIndex + 1
        const firstPageCount = count === 1 ? 1 : 2
        const secondPageIndex = firstPageCount + Number(needsBlank)
        expect(pages).toHaveLength(secondPageIndex + 1)
        expect((secondPageIndex + 1) % 2).toBe(sectionType === SectionType.ODD_PAGE ? 1 : 0)
        expect(pages[secondPageIndex]!.st).toBe(start)
        expect(pages[secondPageIndex]!.ed).toBe(snapshot.body!.dataStream.length - 1)
        expect(pages[secondPageIndex]!.pageNumber).toBe(restart ? 10 : secondPageIndex + 1)
        expect(pages[secondPageIndex]!.headerId).toBe('chapter-first')
        if (needsBlank) {
          const blank = pages[firstPageCount]!
          expect(blank.sections).toHaveLength(0)
          expect(blank.ed).toBeLessThan(blank.st)
          expect(blank.headerId).toBe('')
          expect(blank.footerId).toBe('')
        }
        // Recalculation must not duplicate the implicit page or move content indexes.
        skeleton.makeDirty(true)
        skeleton.calculate()
        expect(skeleton.getSkeletonData()!.pages.map((page) => [page.st, page.ed, page.pageNumber])).toEqual(pages.map((page) => [page.st, page.ed, page.pageNumber]))
      } finally { skeleton.dispose(); model.dispose(); locale.dispose() }
    }
  })

  it.each([false, true])('numbers section pages correctly and renders each section first/even/default parts (restart=%s)', (restart) => {
    const kinds = ['header', 'footer'] as const
    const variants = ['default', 'first', 'even'] as const
    const prefixes = { default: 'default', first: 'firstPage', even: 'evenPage' }
    const sections = Array.from({ length: 3 }, (_, index) => ({
      html: Array.from({ length: 12 }, (_, paragraph) => `<p>Chapter ${index + 1} paragraph ${paragraph + 1}</p>`).join(''),
      style: {
        sectionType: SectionType.NEXT_PAGE,
        useFirstPageHeaderFooter: BooleanNumber.TRUE,
        evenAndOddHeaders: BooleanNumber.TRUE,
        ...(index === 0 ? { pageNumberStart: 3 } : {}),
        ...(restart && index === 1 ? { pageNumberStart: 10 } : {}),
        ...Object.fromEntries(kinds.flatMap((kind) => variants.map((variant) => [
          `${prefixes[variant]}${kind === 'header' ? 'Header' : 'Footer'}Id`, `${kind}-${variant}-${index}`,
        ]))),
      },
      parts: kinds.flatMap((kind) => variants.map((variant) => ({ kind, variant, id: `${kind}-${variant}-${index}`, html: `<p>${kind} ${variant} ${index}</p>` }))),
    }))
    const snapshot = createUniverSectionedDocumentSnapshot('section-layout', 'Sections', { size: 'a4', orientation: 'portrait', margins: 'normal' }, {
      headerHtml: '', footerHtml: '', showPageNumbers: false, differentFirstPage: true, pageNumberStart: 3,
    }, sections)
    snapshot.documentStyle.pageSize = { width: 400, height: 240 }
    snapshot.documentStyle.marginTop = snapshot.documentStyle.marginBottom = 35
    const model = new DocumentDataModel(snapshot)
    const locale = new LocaleService()
    const skeleton = new DocumentSkeleton(new DocumentViewModel(model), locale)
    try {
      skeleton.calculate()
      const pages = skeleton.getSkeletonData()!.pages
      let previousNumber = 2
      for (const [index, section] of snapshot.body!.sectionBreaks!.entries()) {
        const start = index === 0 ? 0 : snapshot.body!.sectionBreaks![index - 1]!.startIndex + 1
        const sectionPages = pages.filter((page) => page.st >= start && page.st <= section.startIndex)
        expect(sectionPages.length).toBeGreaterThan(1)
        for (const [pageIndex, page] of sectionPages.entries()) {
          const expected = pageIndex === 0 && restart && index === 1 ? 10 : previousNumber + 1
          expect(page.pageNumber).toBe(expected)
          let variant = expected % 2 === 0 ? 'even' : 'default'
          if (pageIndex === 0) variant = 'first'
          expect(page.headerId).toBe(`header-${variant}-${index}`)
          expect(page.footerId).toBe(`footer-${variant}-${index}`)
          previousNumber = page.pageNumber
        }
      }
    } finally { skeleton.dispose(); model.dispose(); locale.dispose() }
  })

  it('opens a continuous first section without a preceding page', () => {
    const snapshot = htmlToUniverSnapshot('<p>Continuous first section</p>', 'continuous', 'Continuous')
    snapshot.body!.sectionBreaks![0]!.sectionType = SectionType.CONTINUOUS
    const model = new DocumentDataModel(snapshot)
    const locale = new LocaleService()
    const skeleton = new DocumentSkeleton(new DocumentViewModel(model), locale)
    try { skeleton.calculate(); expect(skeleton.getSkeletonData()!.pages).toHaveLength(1) }
    finally { skeleton.dispose(); model.dispose(); locale.dispose() }
  })

  it.each([
    ['Ordinary text 😀', false], ['1234', false], ['# heading', false], ['* list', false],
    ['1\uFE0F\u20E3 keycap', true], ['#\u20E3 keycap', true], ['*\uFE0F\u20E3 keycap', true],
    ['👨‍👩‍👧‍👦 family', true], ['🇨🇳 flag', true], ['©️ symbol', true], ['中文', false], ['', false],
  ] as const)('preserves grapheme detection for %s', (text, expected) => {
    expect(startWithEmoji(text)).toBe(expected)
  })

  it('shares unformatted glyph styles while keeping styled runs and paragraph styles distinct', () => {
    const model = new DocumentDataModel(htmlToUniverSnapshot('<p>aa<strong>bb</strong>cc</p><h1>dd</h1><p>ee</p>', 'layout', 'Layout'))
    const locale = new LocaleService()
    const skeleton = new DocumentSkeleton(new DocumentViewModel(model), locale)
    try {
      skeleton.calculate()
      const glyphs = skeleton.getSkeletonData()!.pages.flatMap((page) => page.sections.flatMap((section) => section.columns.flatMap((column) => column.lines.flatMap((line) => line.divides.flatMap((divide) => divide.glyphGroup)))))
      const named = (text: string) => glyphs.filter((glyph) => glyph.content === text)
      const plain = named('a')
      expect(plain).toHaveLength(2)
      expect(plain[0]!.ts).toBe(plain[1]!.ts)
      expect(plain[0]!.fontStyle).toBe(plain[1]!.fontStyle)
      expect(named('b')[0]!.ts?.bl).toBe(BooleanNumber.TRUE)
      expect(named('c')[0]!.ts?.bl).not.toBe(BooleanNumber.TRUE)
      expect(named('d')[0]!.ts?.fs).toBeGreaterThan(named('e')[0]!.ts?.fs ?? 11)
      expect(named('e')[0]!.ts?.bl).not.toBe(BooleanNumber.TRUE)
    } finally { skeleton.dispose(); model.dispose(); locale.dispose() }
  })
})
