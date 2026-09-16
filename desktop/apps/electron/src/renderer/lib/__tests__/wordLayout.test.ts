import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { BooleanNumber, DocumentDataModel, LocaleService } from '@univerjs/core'
import { DocumentSkeleton, DocumentViewModel, startWithEmoji } from '@univerjs/engine-render'
import { htmlToUniverSnapshot } from '../wordUniverModel'

GlobalRegistrator.register()
afterAll(async () => { await GlobalRegistrator.unregister() })

describe('Word native layout memory sharing', () => {
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
