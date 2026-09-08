import diff from 'fast-diff'
import type { PresentationTextElement, PresentationTextRun, PresentationTextStyle, PresentationTextParagraph, PresentationParagraphStyle } from '@/atoms/presentation'

const CJK_TEXT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const CJK_FONT_PATTERN = /(思源|黑体|黑體|宋体|宋體|仿宋|楷|行书|行書|毛笔|毛筆|篆|隶|隸|书法|書法|草书|草書|等线|等線|source han|noto (sans|serif) cjk|pingfang|hiragino|yahei|simhei|simsun|mincho|gothic|ming|songti|calligraphy|brush)/i
const CJK_SERIF_FONT_PATTERN = /(宋|明朝|明體|仿宋|楷|serif|mincho|ming|song|kai)/i
const CJK_CALLIGRAPHIC_FONT_PATTERN = /(行书|行書|毛笔|毛筆|篆|隶|隸|书法|書法|草书|草書|calligraphy|brush)/i
const CSS_PIXELS_PER_POINT = 96 / 72

/** Shared natural line metrics used by Fabric and DOM previews. */
export const PRESENTATION_TEXT_LINE_METRICS = { height: 1.13, descent: 0.222 } as const

function quoteFontFamily(fontFamily: string): string {
  const normalized = fontFamily.trim().replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `"${normalized}"`
}

/** Canvas text needs grapheme wrapping for scripts that do not separate words with spaces. */
export function shouldSplitPresentationTextByGrapheme(text: string, wordWrap = true): boolean {
  return wordWrap && presentationTextUsesCjk(text)
}

export function presentationTextUsesCjk(text: string): boolean {
  return CJK_TEXT_PATTERN.test(text)
}

/** Convert a PowerPoint point size into the presentation model's CSS-pixel unit. */
export function presentationFontSizeFromPoints(fontSize: number): number {
  return Number.isFinite(fontSize) ? fontSize * CSS_PIXELS_PER_POINT : 0
}

/** Convert a presentation model CSS-pixel size back into PowerPoint points. */
export function presentationFontSizeToPoints(fontSize: number): number {
  return Number.isFinite(fontSize) ? fontSize / CSS_PIXELS_PER_POINT : 0
}

/** Convert authored point tracking into Fabric's thousandths-of-an-em model. */
export function presentationCharacterSpacingFromPoints(spacing: number, fontSize: number): number {
  if (!Number.isFinite(spacing) || !Number.isFinite(fontSize) || fontSize <= 0) return 0
  return (spacing / fontSize) * 1_000
}

/** Convert Fabric's thousandths-of-an-em tracking back to PowerPoint points. */
export function presentationCharacterSpacingToPoints(spacing: number, fontSize: number): number {
  if (!Number.isFinite(spacing) || !Number.isFinite(fontSize) || fontSize <= 0) return 0
  return (spacing / 1_000) * fontSize
}

/** Preserve the authored font while adding metric-compatible system fallbacks for rendering. */
export function presentationRenderingFontFamily(fontFamily: string, text: string): string {
  const requested = fontFamily.trim() || 'Aptos'
  if (requested.includes(',')) return requested
  const primary = quoteFontFamily(requested)
  if (!presentationTextUsesCjk(text) && !CJK_FONT_PATTERN.test(requested)) {
    const aptosFallback = requested.toLowerCase() === 'aptos' ? '' : ', Aptos'
    return `${primary}${aptosFallback}, "Helvetica Neue", Arial, sans-serif`
  }
  if (CJK_CALLIGRAPHIC_FONT_PATTERN.test(requested)) {
    return `${primary}, "Kaiti SC", STKaiti, "FangSong SC", STFangsong, "Songti SC", STSong, serif`
  }
  if (CJK_SERIF_FONT_PATTERN.test(requested)) {
    return `${primary}, "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, serif`
  }
  return `${primary}, "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`
}

export const PRESENTATION_TEXT_STYLE_KEYS = ['fontSize', 'fontFamily', 'fontWeight', 'italic', 'underline', 'strikethrough', 'baseline', 'highlightColor', 'characterSpacing', 'color'] as const
export const PRESENTATION_TEXT_RUN_STYLE_KEYS = [...PRESENTATION_TEXT_STYLE_KEYS, 'opacity'] as const

/** Resolve inline overrides against the text frame's default style. */
export function presentationTextStyleAt(element: PresentationTextElement, offset: number): PresentationTextStyle {
  const base = Object.fromEntries(PRESENTATION_TEXT_STYLE_KEYS.map(key => [key, element[key]])) as PresentationTextStyle
  const run = element.textRuns?.find(item => item.start <= offset && item.end > offset)
  return { ...base, ...run?.style }
}

/** Empty paragraphs carry their line metrics in the end-paragraph character properties. */
export function presentationParagraphTextStyle(element: PresentationTextElement, paragraph: PresentationTextParagraph): PresentationTextStyle {
  return { ...presentationTextStyleAt(element, paragraph.start), ...(paragraph.start === paragraph.end ? paragraph.endStyle : {}) }
}

/** Return styled segments without flattening differently formatted runs. */
export function presentationTextSegments(element: PresentationTextElement) {
  const offsets = [...new Set([0, element.text.length, ...(element.textRuns ?? []).flatMap(run => [run.start, run.end])])]
    .filter(offset => Number.isInteger(offset) && offset >= 0 && offset <= element.text.length).sort((a, b) => a - b)
  return offsets.slice(0, -1).map((start, index) => ({
    start, end: offsets[index + 1]!, text: element.text.slice(start, offsets[index + 1]),
    style: presentationTextStyleAt(element, start),
  }))
}

export const PRESENTATION_PARAGRAPH_STYLE_KEYS = ['align', 'lineHeight', 'lineSpacing', 'indentLevel', 'listStyle'] as const

export const PRESENTATION_NUMBER_FORMATS = new Set([
  ...['alphaLc', 'alphaUc', 'arabic', 'romanLc', 'romanUc', 'thaiAlpha', 'thaiNum'].flatMap(prefix => ['ParenBoth', 'ParenR', 'Period'].map(suffix => prefix + suffix)),
  'arabicPlain', 'circleNumDbPlain', 'circleNumWdBlackPlain', 'circleNumWdWhitePlain', 'arabicDbPeriod', 'arabicDbPlain',
  'ea1ChsPeriod', 'ea1ChsPlain', 'ea1ChtPeriod', 'ea1ChtPlain', 'ea1JpnChsDbPeriod', 'ea1JpnKorPlain', 'ea1JpnKorPeriod',
  'arabic1Minus', 'arabic2Minus', 'hebrew2Minus', 'hindiAlphaPeriod', 'hindiNumPeriod', 'hindiNumParenR', 'hindiAlpha1Period',
])

/** Keep marker text shared by DOM, editable canvas, and direct-edit cleanup. */
export function presentationNumberMarker(value: number, format = 'arabicPeriod'): string {
  let number = String(value)
  if (format.startsWith('alpha')) {
    number = ''
    for (let remaining = value; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) number = String.fromCharCode(97 + (remaining - 1) % 26) + number
    if (format.startsWith('alphaUc')) number = number.toUpperCase()
  } else if (format.startsWith('roman')) {
    number = ''
    let remaining = value
    for (const [amount, glyph] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const) {
      while (remaining >= amount) { number += glyph; remaining -= amount }
    }
    if (format.startsWith('romanLc')) number = number.toLowerCase()
  } else if (format.startsWith('circleNum') && value <= 20) {
    if (format === 'circleNumWdBlackPlain') return `${String.fromCodePoint((value <= 10 ? 0x2776 : 0x24eb) + value - (value <= 10 ? 1 : 11))} `
    return `${String.fromCodePoint(0x2460 + value - 1)} `
  }
  else if (format.startsWith('arabicDb')) number = number.replace(/\d/g, digit => String.fromCharCode(0xff10 + Number(digit)))
  else if (format.startsWith('thaiNum') || format.startsWith('hindiNum')) number = number.replace(/\d/g, digit => String.fromCharCode((format.startsWith('thai') ? 0x0e50 : 0x0966) + Number(digit)))
  else if (format.startsWith('ea1')) {
    const digits = '零一二三四五六七八九'
    const units = ['', '十', '百', '千', '万']
    number = Array.from(String(value)).map((digit, index, values) => {
      const place = values.length - index - 1
      if (digit === '0') return values.slice(index + 1).some(value => value !== '0') && values[index - 1] !== '0' ? '零' : ''
      return `${digits[Number(digit)]}${units[place] ?? ''}`
    }).join('').replace(/^一十/, '十')
  }
  if (format.endsWith('ParenBoth')) return `(${number}) `
  if (format.endsWith('ParenR')) return `${number}) `
  if (format.endsWith('Plain')) return `${number} `
  if (format.endsWith('Minus')) return `${number}- `
  if (format.startsWith('ea1') || format === 'arabicDbPeriod') return `${number}． `
  return `${number}. `
}

/** Resolve authored paragraphs, treating plain-text newlines as paragraph breaks. */
export function presentationTextParagraphs(element: PresentationTextElement) {
  let offset = 0
  const paragraphs: PresentationTextParagraph[] = element.paragraphs?.length ? element.paragraphs : element.text.split('\n').map(text => {
    const start = offset
    offset += text.length + 1
    return { start, end: start + text.length, style: {} }
  })
  const base = Object.fromEntries(PRESENTATION_PARAGRAPH_STYLE_KEYS.map(key => [key, element[key]])) as PresentationParagraphStyle
  const counters = new Map<number, { start: number; value: number; format: string }>()
  return paragraphs.map(paragraph => {
    const text = element.text.slice(paragraph.start, paragraph.end)
    const style = { ...base, ...paragraph.style }
    const level = style.indentLevel ?? 0
    for (const depth of counters.keys()) if (depth > level) counters.delete(depth)
    let marker = ''
    if (style.listStyle === 'number') {
      const previous = counters.get(level)
      const start = style.listStartAt ?? previous?.start ?? 1
      const format = style.listNumberFormat ?? 'arabicPeriod'
      const value = previous?.start === start && previous.format === format ? previous.value + 1 : start
      counters.set(level, { start, value: text.trim() ? value : value - 1, format })
      if (text.trim()) marker = presentationNumberMarker(value, format)
    } else {
      counters.delete(level)
      if (style.listStyle === 'bullet' && text.trim()) marker = `${style.listBulletChar ?? '•'} `
    }
    return { ...paragraph, text, style, marker }
  })
}

export function presentationParagraphSegments(element: PresentationTextElement, paragraph: PresentationTextParagraph, index: number, markers = true) {
  const prefix = 'marker' in paragraph ? paragraph.marker as string : presentationTextParagraphs(element)[index]?.marker ?? ''
  return [
    ...(markers && prefix
      ? [{ text: prefix, start: paragraph.start, end: paragraph.start, style: {
        ...presentationTextStyleAt(element, paragraph.start),
        ...(paragraph.style.listMarkerFontFamily ? { fontFamily: paragraph.style.listMarkerFontFamily } : {}),
      } }] : []),
    ...presentationTextSegments(element).filter(segment => segment.end > paragraph.start && segment.start < paragraph.end).map(segment => {
      const start = Math.max(paragraph.start, segment.start)
      const end = Math.min(paragraph.end, segment.end)
      return { ...segment, start, end, text: element.text.slice(start, end) }
    }),
  ]
}

export function presentationTextDisplaySegments(element: PresentationTextElement) {
  return presentationTextParagraphs(element).flatMap((paragraph, index) => [
    ...(index ? [{ text: '\n', start: paragraph.start - 1, end: paragraph.start, style: presentationTextStyleAt(element, paragraph.start) }] : []),
    ...presentationParagraphSegments(element, paragraph, index),
  ])
}

/** Scale paragraph distances with the frame while retaining proportional spacing. */
export function scalePresentationParagraphs(paragraphs: PresentationTextParagraph[] | undefined, scale: number) {
  return paragraphs?.map(paragraph => ({ ...paragraph,
    ...(paragraph.endStyle?.fontSize === undefined ? {} : { endStyle: { ...paragraph.endStyle, fontSize: paragraph.endStyle.fontSize * scale } }),
    style: {
    ...paragraph.style,
    ...(paragraph.style.lineSpacing === undefined ? {} : { lineSpacing: paragraph.style.lineSpacing * scale }),
    ...(paragraph.style.spaceBefore === undefined ? {} : { spaceBefore: paragraph.style.spaceBefore * scale }),
    ...(paragraph.style.spaceAfter === undefined ? {} : { spaceAfter: paragraph.style.spaceAfter * scale }),
  } }))
}

/** Preserve every unchanged range when an edit changes several separate parts of a text box. */
export function patchPresentationText(element: PresentationTextElement, patch: Partial<PresentationTextElement>): PresentationTextElement {
  let runs = 'textRuns' in patch ? patch.textRuns : element.textRuns
  let paragraphs = 'paragraphs' in patch ? patch.paragraphs : element.paragraphs
  if (patch.text !== undefined && patch.text !== element.text && (runs || paragraphs)) {
    const next = patch.text
    const adjusted: PresentationTextRun[] = []
    const sourceOffsets = new Int32Array(next.length).fill(-1)
    const inheritedOffsets = new Int32Array(next.length)
    let previous = 0
    let current = 0
    let deletedAt: number | null = null
    for (const [operation, text] of diff(element.text, next)) {
      if (operation === diff.DELETE) { deletedAt ??= previous; previous += text.length; continue }
      if (operation === diff.EQUAL) {
        for (let index = 0; index < text.length; index++) sourceOffsets[current + index] = inheritedOffsets[current + index] = previous + index
        for (const run of runs ?? []) {
          const start = Math.max(previous, run.start)
          const end = Math.min(previous + text.length, run.end)
          if (end > start) adjusted.push({ start: current + start - previous, end: current + end - previous, style: run.style })
        }
        previous += text.length
      } else {
        const source = deletedAt ?? Math.max(0, previous - 1)
        inheritedOffsets.fill(source, current, current + text.length)
        adjusted.push({ start: current, end: current + text.length, style: presentationTextStyleAt(element, source) })
      }
      current += text.length
      deletedAt = null
    }
    if (runs && !('textRuns' in patch)) runs = adjusted
    if (paragraphs && !('paragraphs' in patch)) {
      const oldParagraphs = presentationTextParagraphs(element)
      const hardBreaks = new Set(oldParagraphs.slice(0, -1).map(paragraph => paragraph.end))
      const ends = Array.from({ length: next.length }, (_, index) => index).filter(index => (
        next[index] === '\n' && (sourceOffsets[index]! < 0 || hardBreaks.has(sourceOffsets[index]!))
      ))
      let start = 0
      paragraphs = [...ends, next.length].map(end => {
        let source = start < next.length ? inheritedOffsets[start]! : Math.min(element.text.length, (inheritedOffsets[start - 1] ?? -1) + 1)
        for (let offset = start; offset < end; offset++) {
          if (sourceOffsets[offset]! >= 0 && next[offset] !== '\n') { source = sourceOffsets[offset]!; break }
        }
        const original = oldParagraphs.find(paragraph => paragraph.start <= source && paragraph.end >= source) ?? oldParagraphs[0]!
        const paragraph = { start, end, style: { ...original.style }, ...(original.endStyle ? { endStyle: { ...original.endStyle } } : {}) }
        start = end + 1
        return paragraph
      })
    }
  }
  if (runs && !('textRuns' in patch)) runs = runs.map(run => {
    const style = { ...run.style }
    for (const key of PRESENTATION_TEXT_STYLE_KEYS) {
      if (!(key in patch)) continue
      if (key === 'fontSize' && patch.fontSize !== undefined) style.fontSize = (run.style.fontSize ?? element.fontSize) * patch.fontSize / element.fontSize
      else Object.assign(style, { [key]: patch[key] })
    }
    return { ...run, style }
  })
  if (paragraphs && !('paragraphs' in patch)) paragraphs = paragraphs.map(paragraph => {
    const style = { ...paragraph.style }
    const endStyle = paragraph.endStyle ? { ...paragraph.endStyle } : undefined
    if (endStyle) for (const key of PRESENTATION_TEXT_STYLE_KEYS) {
      if (!(key in patch)) continue
      if (key === 'fontSize' && patch.fontSize !== undefined) endStyle.fontSize = (endStyle.fontSize ?? element.fontSize) * patch.fontSize / element.fontSize
      else Object.assign(endStyle, { [key]: patch[key] })
    }
    for (const key of PRESENTATION_PARAGRAPH_STYLE_KEYS) if (key in patch) Object.assign(style, { [key]: patch[key] })
    if ('lineHeight' in patch && !('lineSpacing' in patch)) style.lineSpacing = undefined
    return { ...paragraph, style, ...(endStyle ? { endStyle } : {}) }
  })
  return { ...element, ...patch, ...('lineHeight' in patch && !('lineSpacing' in patch) ? { lineSpacing: undefined } : {}),
    ...(runs ? { textRuns: runs } : {}), ...(paragraphs ? { paragraphs } : {}),
  }
}

/** Clockwise and counterclockwise text use a horizontal layout in a rotated inner frame. */
export function presentationTextFrame(element: PresentationTextElement) {
  const inset = element.textInsets ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const width = Math.max(1, element.width - inset.left - inset.right)
  const height = Math.max(1, element.height - inset.top - inset.bottom)
  if (element.textDirection === 'vertical') return { x: inset.left + width, y: inset.top, width: height, height: width, rotation: 90 }
  if (element.textDirection === 'vertical270') return { x: inset.left, y: inset.top + height, width: height, height: width, rotation: -90 }
  return { x: inset.left, y: inset.top, width, height, rotation: 0 }
}

/** Match Fabric's script metrics in DOM previews. */
export function presentationScriptMetrics(style: PresentationTextStyle) {
  const fontSize = style.fontSize ?? 24
  if (style.baseline === 'superscript') return { fontSize: fontSize * 0.6, deltaY: fontSize * -0.35 }
  if (style.baseline === 'subscript') return { fontSize: fontSize * 0.6, deltaY: fontSize * 0.11 }
  return { fontSize, deltaY: 0 }
}
