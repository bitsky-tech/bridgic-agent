const CJK_TEXT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const CJK_FONT_PATTERN = /(思源|黑体|黑體|宋体|宋體|仿宋|楷|行书|行書|毛笔|毛筆|篆|隶|隸|书法|書法|草书|草書|等线|等線|source han|noto (sans|serif) cjk|pingfang|hiragino|yahei|simhei|simsun|mincho|gothic|ming|songti|calligraphy|brush)/i
const CJK_SERIF_FONT_PATTERN = /(宋|明朝|明體|仿宋|楷|serif|mincho|ming|song|kai)/i
const CJK_CALLIGRAPHIC_FONT_PATTERN = /(行书|行書|毛笔|毛筆|篆|隶|隸|书法|書法|草书|草書|calligraphy|brush)/i
const CSS_PIXELS_PER_POINT = 96 / 72

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
