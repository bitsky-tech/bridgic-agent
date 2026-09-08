import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { PresentationElement, PresentationTextElement, PresentationTextStyle } from '@/atoms/presentation'
import {
  presentationCharacterSpacingToPoints,
  presentationFontSizeToPoints,
  presentationParagraphSegments,
  presentationTextParagraphs,
  presentationTextStyleAt,
} from './presentationText'

const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const points = (value: number) => Math.round(presentationFontSizeToPoints(value) * 100)
const color = (value: string | undefined, fallback = '20202B') => /^#?[\da-f]{6}$/i.test(value ?? '') ? value!.replace('#', '') : fallback

/** Generate one legal DrawingML paragraph per model paragraph, with explicit soft breaks. */
function textParagraphXml(element: PresentationTextElement, hyperlinkXml: string, effectsXml: string): string {
  const runProperties = (style: PresentationTextStyle, tag = 'rPr') => {
    const fontSize = style.fontSize ?? element.fontSize
    const family = escapeXml(style.fontFamily ?? element.fontFamily)
    let baseline = 0
    if (style.baseline === 'superscript') baseline = 30000
    else if (style.baseline === 'subscript') baseline = -25000
    const alpha = Math.round(Math.max(0, Math.min(1, (element.opacity ?? 1) * (style.opacity ?? 1))) * 100000)
    const tracking = Math.round(presentationCharacterSpacingToPoints(style.characterSpacing ?? 0, presentationFontSizeToPoints(fontSize)) * 100)
    return `<a:${tag} lang="en-US" sz="${points(fontSize)}" b="${(style.fontWeight ?? 400) >= 600 ? 1 : 0}" i="${style.italic ? 1 : 0}" u="${style.underline || hyperlinkXml ? 'sng' : 'none'}" strike="${style.strikethrough ? 'sngStrike' : 'noStrike'}" baseline="${baseline}" spc="${tracking}"><a:solidFill><a:srgbClr val="${hyperlinkXml ? '2563EB' : color(style.color)}">${alpha < 100000 ? `<a:alpha val="${alpha}"/>` : ''}</a:srgbClr></a:solidFill>${effectsXml}${style.highlightColor ? `<a:highlight><a:srgbClr val="${color(style.highlightColor, 'FFFF00')}"/></a:highlight>` : ''}<a:latin typeface="${family}"/><a:ea typeface="${family}"/><a:cs typeface="${family}"/>${hyperlinkXml}</a:${tag}>`
  }
  return presentationTextParagraphs(element).map((paragraph, index) => {
    const style = paragraph.style
    const align = { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[style.align ?? 'left']
    const line = style.lineSpacing ? `<a:spcPts val="${points(style.lineSpacing)}"/>` : `<a:spcPct val="${Math.round((style.lineHeight ?? 1.08) * 100000)}"/>`
    let bullet = '<a:buNone/>'
    if (style.listStyle === 'bullet') bullet = `<a:buChar char="${escapeXml(style.listBulletChar ?? '•')}"/>`
    else if (style.listStyle === 'number') bullet = `<a:buAutoNum type="${escapeXml(style.listNumberFormat ?? 'arabicPeriod')}"${style.listStartAt === undefined ? '' : ` startAt="${style.listStartAt}"`}/>`
    if (style.listStyle && style.listStyle !== 'none' && style.listMarkerFontFamily) bullet = `<a:buFont typeface="${escapeXml(style.listMarkerFontFamily)}"/>${bullet}`
    const properties = `<a:pPr algn="${align}" lvl="${Math.max(0, Math.min(8, style.indentLevel ?? 0))}" marL="${Math.round((style.indentLevel ?? 0) * 16 * 9525)}"><a:lnSpc>${line}</a:lnSpc><a:spcBef><a:spcPts val="${points(style.spaceBefore ?? 0)}"/></a:spcBef><a:spcAft><a:spcPts val="${points(style.spaceAfter ?? 0)}"/></a:spcAft>${bullet}</a:pPr>`
    const runs = presentationParagraphSegments(element, paragraph, index, false).map(segment => (
      segment.text.split('\n').map((text, lineIndex) => `${lineIndex ? '<a:br/>' : ''}${text ? `<a:r>${runProperties(segment.style)}<a:t${/^\s|\s$/u.test(text) ? ' xml:space="preserve"' : ''}>${escapeXml(text)}</a:t></a:r>` : ''}`).join('')
    )).join('')
    const endStyle = { ...presentationTextStyleAt(element, Math.max(paragraph.start, paragraph.end - 1)), ...paragraph.endStyle }
    return `<a:p>${properties}${runs}${runProperties(endStyle, 'endParaRPr')}</a:p>`
  }).join('')
}

/** Replace generated text paragraphs while retaining shape geometry, body settings and hyperlink relationships. */
export function correctPresentationTextXml(xml: string, elements: readonly PresentationElement[]): string {
  const texts = new Map(elements.filter((element): element is PresentationTextElement => element.type === 'text').map(element => [element.id, element]))
  if (!texts.size) return xml
  const parser = new DOMParser()
  const serializer = new XMLSerializer()
  const document = parser.parseFromString(xml, 'text/xml')
  for (const shape of Array.from(document.getElementsByTagNameNS(PRESENTATION_NS, 'sp'))) {
    const name = shape.getElementsByTagNameNS(PRESENTATION_NS, 'cNvPr')[0]?.getAttribute('name')
    const element = name ? texts.get(name) : undefined
    const body = shape.getElementsByTagNameNS(PRESENTATION_NS, 'txBody')[0]
    if (!element || !body) continue
    const hyperlinks = ['hlinkClick', 'hlinkMouseOver'].flatMap(name => {
      const link = body.getElementsByTagNameNS(DRAWING_NS, name)[0]
      return link ? [serializer.serializeToString(link)] : []
    }).join('')
    const effects = body.getElementsByTagNameNS(DRAWING_NS, 'effectLst')[0]
    const paragraphs = parser.parseFromString(`<root xmlns:a="${DRAWING_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${textParagraphXml(element, hyperlinks, effects ? serializer.serializeToString(effects) : '')}</root>`, 'text/xml')
    for (const child of Array.from(body.childNodes)) if (child.nodeType === 1 && 'localName' in child && child.localName === 'p') body.removeChild(child)
    for (const paragraph of Array.from(paragraphs.documentElement.childNodes)) body.appendChild(document.importNode(paragraph, true))
  }
  return serializer.serializeToString(document)
}
