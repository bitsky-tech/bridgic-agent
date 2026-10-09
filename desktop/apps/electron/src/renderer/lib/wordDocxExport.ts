import JSZip from 'jszip'
import { BaselineOffset, HorizontalAlign, ListGlyphType, PageOrientType, PRESET_LIST_TYPE, SectionType, TabStopAlignment, type IDocumentBody, type IDocumentStyle, type ISectionBreak, type IListData, type ITextStyle } from '@univerjs/core'
import type { WordDocumentState } from './wordDomain'
import { writeOfficeRoundTrip } from './office/officeRoundTrip'
import { prepareWordHtmlImages, prepareWordSnapshotImages } from './wordImages'
import type { WordHtmlSection } from './wordUniverModel'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const xml = (value: unknown) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const documentXml = (body: string, tag = 'document') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${tag} xmlns:w="${W}" xmlns:r="${R}">${body}</w:${tag}>`
const color = (value: unknown) => {
  if (typeof value !== 'string' || !value) return undefined
  const hex = value.replace('#', '')
  if (/^[\da-f]{6}$/i.test(hex)) return hex
  if (/^[\da-f]{3}$/i.test(hex)) return [...hex].map((part) => part + part).join('')
  const rgb = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  return rgb ? rgb.slice(1).map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('') : undefined
}

/** Encode the editor's document as standard OOXML, including tables and embedded images. */
export async function exportWordDocx(document: WordDocumentState): Promise<Uint8Array> {
  document = { ...document, snapshot: await prepareWordSnapshotImages(document.snapshot), headerFooter: {
    ...document.headerFooter,
    headerHtml: await prepareWordHtmlImages(document.headerFooter.headerHtml),
    footerHtml: await prepareWordHtmlImages(document.headerFooter.footerHtml),
  } }
  const zip = new JSZip()
  const relationships: string[] = []
  const contentTypes: string[] = []
  const lists = new Map<string, { id: number; ordered: boolean; source?: IListData }>()
  const secondaryParts: string[] = []
  let nextId = 0
  const relation = (type: string, target: string, external = false) => {
    const id = `rId${++nextId}`
    relationships.push(`<Relationship Id="${id}" Type="${R}/${type}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ''}/>`)
    return id
  }
  const textStyle = (style: ITextStyle) => {
    const parts: string[] = []
    if (style.bl) parts.push('<w:b/>')
    if (style.it) parts.push('<w:i/>')
    if (style.ul?.s) parts.push('<w:u w:val="single"/>')
    if (style.st?.s) parts.push('<w:strike/>')
    if (style.ff) parts.push(`<w:rFonts w:ascii="${xml(style.ff)}" w:hAnsi="${xml(style.ff)}" w:eastAsia="${xml(style.ff)}"/>`)
    if (style.fs) parts.push(`<w:sz w:val="${Math.round(style.fs * 2)}"/><w:szCs w:val="${Math.round(style.fs * 2)}"/>`)
    if (style.sc !== undefined) parts.push(`<w:spacing w:val="${Math.round(style.sc * 15)}"/>`)
    const foreground = color(style.cl?.rgb)
    const background = color(style.bg?.rgb)
    if (foreground) parts.push(`<w:color w:val="${foreground}"/>`)
    if (background) parts.push(`<w:shd w:fill="${background}"/>`)
    if (style.va === BaselineOffset.SUBSCRIPT || style.va === BaselineOffset.SUPERSCRIPT) parts.push(`<w:vertAlign w:val="${style.va === BaselineOffset.SUBSCRIPT ? 'subscript' : 'superscript'}"/>`)
    return parts.join('')
  }
  const image = (body: IDocumentBody, index: number) => {
    const block = body.customBlocks?.find((item) => item.startIndex === index)
    const drawing = block ? document.snapshot.drawings?.[block.blockId] : undefined
    if (!drawing || !('source' in drawing) || typeof drawing.source !== 'string') throw new Error('The document contains an unsupported drawing')
    const encoded = drawing.source.match(/^data:image\/(png|jpeg|jpg|gif);base64,(.+)$/s)
    if (!encoded) throw new Error('Save requires embedded PNG, JPEG or GIF images')
    const extension = encoded[1] === 'jpg' ? 'jpeg' : encoded[1]!
    const name = `image${nextId + 1}.${extension}`
    zip.file(`word/media/${name}`, encoded[2]!, { base64: true })
    contentTypes.push(`<Default Extension="${extension}" ContentType="image/${extension}"/>`)
    const id = relation('image', `media/${name}`)
    const width = Math.round((drawing.docTransform?.size.width ?? 320) * 9525)
    const height = Math.round((drawing.docTransform?.size.height ?? 200) * 9525)
    return `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${nextId}" name="${name}" descr="${xml(drawing.description)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${nextId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  }
  let sectionOrdinal = 0
  const bodyXml = (body: IDocumentBody, main = false): string => {
    const stream = body.dataStream
    let cursor = 0
    const runs = (start: number, end: number) => {
      let output = ''
      for (let index = start; index < end;) {
        const run = body.textRuns?.find((item) => item.st <= index && item.ed > index)
        const style = run?.ts ?? {}
        const field = body.customRanges?.find((item) => item.startIndex === index && item.properties?.bridgicKind === 'pageField')
        if (field && (field.properties?.field === 'PAGE' || field.properties?.field === 'NUMPAGES')) {
          const source = String(field.properties.instruction ?? field.properties.field).trim()
          const instruction = source.match(/^(PAGE|NUMPAGES)\b/i)?.[1]?.toUpperCase() === field.properties.field ? source : field.properties.field
          output += `<w:fldSimple w:instr="${xml(instruction)}" w:dirty="true"><w:r><w:rPr>${textStyle(style)}</w:rPr><w:t>${xml(field.properties.cached ?? '1')}</w:t></w:r></w:fldSimple>`
          index = field.endIndex + 1
          continue
        }
        const reference = body.customRanges?.find((item) => item.startIndex === index && item.properties?.bridgicKind === 'footnote')
        if (reference) {
          const footnoteId = document.footnotes.findIndex((item) => item.id === reference.rangeId) + 1
          if (footnoteId > 0) { output += `<w:r><w:footnoteReference w:id="${footnoteId}"/></w:r>`; index = reference.endIndex + 1; continue }
        }
        const link = body.customRanges?.find((item) => item.startIndex <= index && item.endIndex >= index && (typeof item.properties?.url === 'string' || typeof item.properties?.href === 'string'))
        let text: string
        if (stream[index] === '\b') { text = image(body, index); index++ }
        else if (stream[index] === '\f') { text = '<w:br w:type="page"/>'; index++ }
        else if (stream[index] === '\t') { text = '<w:tab/>'; index++ }
        else {
          let next = index + 1
          while (next < end && !/[\b\f\t]/.test(stream[next]!) && next !== run?.ed
            && next !== (link?.endIndex ?? -2) + 1
            && !body.textRuns?.some((item) => item.st === next) && !body.customRanges?.some((item) => item.startIndex === next)) next++
          text = `<w:t xml:space="preserve">${xml(stream.slice(index, next))}</w:t>`
          index = next
        }
        const encodedRun = `<w:r><w:rPr>${textStyle(style)}</w:rPr>${text}</w:r>`
        const href = link?.properties?.url ?? link?.properties?.href
        output += typeof href === 'string' && /^(https?:|mailto:)/i.test(href)
          ? `<w:hyperlink r:id="${relation('hyperlink', href, true)}">${encodedRun}</w:hyperlink>` : encodedRun
      }
      return output
    }
    const paragraphs = (endToken?: string): string => {
      let output = ''
      while (cursor < stream.length && stream[cursor] !== endToken) {
        if (stream[cursor] === '\x1a') { output += table(); continue }
        if (stream[cursor] === '\n' || stream[cursor] === '\0') {
          if (main && !endToken && stream[cursor] === '\n' && cursor < stream.length - 1) {
            const section = body.sectionBreaks?.find((item) => item.startIndex === cursor)
            output += `<w:p><w:pPr><w:sectPr>${sectionXml(section ?? {}, sectionOrdinal++)}</w:sectPr></w:pPr></w:p>`
          }
          cursor++; continue
        }
        const start = cursor
        while (cursor < stream.length && !['\r', '\n', '\x1a', ...(endToken ? [endToken] : [])].includes(stream[cursor]!)) cursor++
        const paragraph = body.paragraphs?.find((item) => item.startIndex === cursor)
        const style = paragraph?.paragraphStyle
        let props = ''
        if (style?.namedStyleType && style.namedStyleType >= 4) props += `<w:pStyle w:val="Heading${style.namedStyleType - 3}"/>`
        const alignment = new Map([[HorizontalAlign.CENTER, 'center'], [HorizontalAlign.RIGHT, 'right'], [HorizontalAlign.JUSTIFIED, 'both']]).get(style?.horizontalAlign ?? HorizontalAlign.LEFT) ?? 'left'
        props += `<w:jc w:val="${alignment}"/>`
        if (style?.indentStart || style?.indentEnd || style?.indentFirstLine || style?.hanging) props += `<w:ind w:left="${Math.round((style.indentStart?.v ?? 0) * 15)}" w:right="${Math.round((style.indentEnd?.v ?? 0) * 15)}" ${style.hanging ? `w:hanging="${Math.round(style.hanging.v * 15)}"` : `w:firstLine="${Math.round((style.indentFirstLine?.v ?? 0) * 15)}"`}/>`
        if (style?.tabStops?.length) {
          const tabAlignment = new Map([[TabStopAlignment.CENTER, 'center'], [TabStopAlignment.END, 'right']])
          props += `<w:tabs>${style.tabStops.map((tab) => `<w:tab w:val="${tabAlignment.get(tab.alignment) ?? 'left'}" w:pos="${Math.round(tab.offset * 15)}"/>`).join('')}</w:tabs>`
        }
        if (style?.keepNext !== undefined) props += `<w:keepNext w:val="${style.keepNext}"/>`
        if (style?.keepLines !== undefined) props += `<w:keepLines w:val="${style.keepLines}"/>`
        const spacing: string[] = []
        if (style?.lineSpacing) spacing.push(`w:line="${Math.round(style.lineSpacing * 240)}" w:lineRule="auto"`)
        if (style?.spaceAbove) spacing.push(`w:before="${Math.round(style.spaceAbove.v * 15)}"`)
        if (style?.spaceBelow) spacing.push(`w:after="${Math.round(style.spaceBelow.v * 15)}"`)
        if (spacing.length) props += `<w:spacing ${spacing.join(' ')}/>`
        if (paragraph?.bullet) {
          const { listId, listType, nestingLevel } = paragraph.bullet
          let list = lists.get(listId)
          if (!list) {
            const source = document.snapshot.lists?.[listType] ?? document.snapshot.lists?.[listId] ?? PRESET_LIST_TYPE[listType]
            list = { id: lists.size + 1, ordered: listType.startsWith('ORDER_LIST'), source }
            lists.set(listId, list)
          }
          props += `<w:numPr><w:ilvl w:val="${Math.min(8, nestingLevel ?? 0)}"/><w:numId w:val="${list.id}"/></w:numPr>`
        }
        const endsSection = main && !endToken && stream[cursor] === '\r' && stream[cursor + 1] === '\n' && cursor + 1 < stream.length - 1
        if (endsSection) {
          const section = body.sectionBreaks?.find((item) => item.startIndex === cursor + 1)
          props += `<w:sectPr>${sectionXml(section ?? {}, sectionOrdinal++)}</w:sectPr>`
        }
        output += `<w:p><w:pPr>${props}</w:pPr>${runs(start, cursor)}</w:p>`
        if (stream[cursor] === '\r') { cursor++; if (endsSection) cursor++ }
      }
      return output || '<w:p/>'
    }
    const table = (): string => {
      const start = cursor++
      const metadata = body.tables?.find((item) => item.startIndex === start)
      const source = metadata ? document.snapshot.tableSource?.[metadata.tableId] : undefined
      let output = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="auto"/>`).join('') + '</w:tblBorders></w:tblPr>'
      output += `<w:tblGrid>${source?.tableColumns.map((col) => `<w:gridCol w:w="${Math.round(col.size.width.v * 15)}"/>`).join('') ?? ''}</w:tblGrid>`
      let row = -1
      let col = 0
      while (cursor < stream.length && stream[cursor] !== '\x0f') {
        const token = stream[cursor++]
        if (token === '\x1b') { output += '<w:tr>'; row++; col = 0 }
        else if (token === '\x0e') output += '</w:tr>'
        else if (token === '\x1c') {
          const cellColumn = col++
          let cell = source?.tableRows[row]?.tableCells[cellColumn]
          let originRow = row
          let originColumn = cellColumn
          if (cell?.columnSpan === 0 || cell?.rowSpan === 0) {
            for (let previousRow = 0; previousRow <= row; previousRow++) {
              for (let previousColumn = 0; previousColumn <= cellColumn; previousColumn++) {
                const candidate = source?.tableRows[previousRow]?.tableCells[previousColumn]
                if (candidate && previousRow + (candidate.rowSpan ?? 1) > row && previousColumn + (candidate.columnSpan ?? 1) > cellColumn) {
                  cell = candidate; originRow = previousRow; originColumn = previousColumn
                }
              }
            }
          }
          const content = paragraphs('\x1d')
          if (stream[cursor] === '\x1d') cursor++
          if (originColumn !== cellColumn) continue
          const fill = color(cell?.backgroundColor?.rgb)
          let properties = fill ? `<w:shd w:fill="${fill}"/>` : ''
          if ((cell?.columnSpan ?? 1) > 1) properties += `<w:gridSpan w:val="${cell!.columnSpan}"/>`
          if ((cell?.rowSpan ?? 1) > 1) properties += `<w:vMerge${originRow === row ? ' w:val="restart"' : ''}/>`
          output += `<w:tc><w:tcPr>${properties}</w:tcPr>${content}</w:tc>`
        }
      }
      if (stream[cursor] === '\x0f') cursor++
      return `${output}</w:tbl><w:p/>`
    }
    return paragraphs()
  }
  const style = document.snapshot.documentStyle
  const exportedParts = new Map<string, string>()
  const sectionXml = (config: Partial<IDocumentStyle & ISectionBreak & WordHtmlSection['style']>, ordinal: number): string => {
    const current = { ...style, ...config }
    let output = ''
    for (const [kind, values] of [['header', document.snapshot.headers], ['footer', document.snapshot.footers]] as const) {
      const variants = kind === 'header'
        ? [['default', current.defaultHeaderId], ['first', current.firstPageHeaderId], ['even', current.evenPageHeaderId]] as const
        : [['default', current.defaultFooterId], ['first', current.firstPageFooterId], ['even', current.evenPageFooterId]] as const
      for (const [type, segmentId] of variants) {
        // An explicit empty override cannot be omitted after a nonempty section:
        // Word would otherwise link it to the preceding section on reopening.
        const emptyOverride = ordinal > 0 && segmentId === '' && Object.keys(values ?? {}).length > 0
        const fallback = type === 'default' && segmentId === undefined && !variants.some(([, id]) => id) ? Object.values(values ?? {})[0] : undefined
        const part = segmentId ? values?.[segmentId] : fallback
        if (!part?.body && !emptyOverride && !(type === 'default' && kind === 'footer' && document.headerFooter.showPageNumbers)) continue
        const key = `${kind}:${segmentId || (emptyOverride ? 'empty' : 'fallback')}`
        let id = exportedParts.get(key)
        if (!id) {
          const base = type === 'default' ? kind : `${kind}-${type}`
          let name = base
          let suffix = 2
          while (secondaryParts.includes(name)) name = `${base}-${suffix++}`
          id = relation(kind, `${name}.xml`)
          exportedParts.set(key, id)
          zip.file(`word/${name}.xml`, documentXml((part?.body ? bodyXml(part.body) : '<w:p/>') + (kind === 'footer' && document.headerFooter.showPageNumbers ? '<w:p><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>' : ''), kind === 'header' ? 'hdr' : 'ftr'))
          secondaryParts.push(name)
          contentTypes.push(`<Override PartName="/word/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`)
        }
        output += `<w:${kind}Reference w:type="${type}" r:id="${id}"/>`
      }
    }
    if (current.useFirstPageHeaderFooter ?? document.headerFooter.differentFirstPage) output += '<w:titlePg/>'
    const type = new Map([[SectionType.CONTINUOUS, 'continuous'], [SectionType.EVEN_PAGE, 'evenPage'], [SectionType.ODD_PAGE, 'oddPage']]).get(current.sectionType ?? SectionType.NEXT_PAGE)
    if (type) output += `<w:type w:val="${type}"/>`
    const start = ordinal === 0 || config.pageNumberStart !== undefined ? config.pageNumberStart ?? style.pageNumberStart ?? document.headerFooter.pageNumberStart : undefined
    if (start !== undefined || config.pageNumberFormat !== undefined) output += `<w:pgNumType${start !== undefined ? ` w:start="${start}"` : ''}${config.pageNumberFormat !== undefined ? ` w:fmt="${config.pageNumberFormat}"` : ''}/>`
    const width = current.pageSize?.width ?? 794
    const height = current.pageSize?.height ?? 1124
    const landscape = current.pageOrient === undefined ? document.page.orientation === 'landscape' : current.pageOrient === PageOrientType.LANDSCAPE
    output += `<w:pgSz w:w="${Math.round((landscape ? Math.max(width, height) : Math.min(width, height)) * 15)}" w:h="${Math.round((landscape ? Math.min(width, height) : Math.max(width, height)) * 15)}"${landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${Math.round((current.marginTop ?? 72) * 15)}" w:bottom="${Math.round((current.marginBottom ?? 72) * 15)}" w:left="${Math.round((current.marginLeft ?? 72) * 15)}" w:right="${Math.round((current.marginRight ?? 72) * 15)}" w:header="${Math.round((current.marginHeader ?? 30) * 15)}" w:footer="${Math.round((current.marginFooter ?? 30) * 15)}" w:gutter="0"/>`
    return output
  }
  const nativeBody = document.snapshot.body ?? { dataStream: '\r\n' }
  const body = bodyXml(nativeBody, true)
  const section = sectionXml(nativeBody.sectionBreaks?.find((item) => item.startIndex === nativeBody.dataStream.length - 1) ?? {}, sectionOrdinal)
  if (document.footnotes.length) {
    relation('footnotes', 'footnotes.xml')
    zip.file('word/footnotes.xml', documentXml(document.footnotes.map((note, index) => `<w:footnote w:id="${index + 1}"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${xml(note.text)}</w:t></w:r></w:p></w:footnote>`).join(''), 'footnotes'))
    contentTypes.push('<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>')
  }
  if (style.evenAndOddHeaders || nativeBody.sectionBreaks?.some((item) => item.evenAndOddHeaders)) {
    relation('settings', 'settings.xml')
    zip.file('word/settings.xml', documentXml('<w:evenAndOddHeaders/>', 'settings'))
    contentTypes.push('<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>')
  }
  relation('styles', 'styles.xml')
  zip.file('word/styles.xml', documentXml(Array.from({ length: 5 }, (_, index) => `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}"/><w:pPr><w:outlineLvl w:val="${index}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - index * 2}"/></w:rPr></w:style>`).join(''), 'styles'))
  contentTypes.push('<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>')
  if (lists.size) {
    relation('numbering', 'numbering.xml')
    const formats = new Map([[ListGlyphType.DECIMAL, 'decimal'], [ListGlyphType.DECIMAL_ZERO, 'decimalZero'], [ListGlyphType.UPPER_LETTER, 'upperLetter'], [ListGlyphType.LOWER_LETTER, 'lowerLetter'], [ListGlyphType.UPPER_ROMAN, 'upperRoman'], [ListGlyphType.LOWER_ROMAN, 'lowerRoman']])
    const numbering = [...lists.values()].map((list) => {
      const levels = Array.from({ length: 9 }, (_, level) => {
        const source = list.source?.nestingLevel[level]
        const symbol = source?.glyphSymbol
        const fallbackFormat = list.ordered ? 'decimal' : 'bullet'
        const format = symbol ? 'bullet' : formats.get(source?.glyphType ?? ListGlyphType.BULLET) ?? fallbackFormat
        const text = symbol || source?.glyphFormat || (list.ordered ? `%${level + 1}.` : '•')
        const paragraph = source?.paragraphProperties
        const hanging = Math.round((paragraph?.hanging?.v ?? 24) * 15)
        const left = paragraph ? Math.round(((paragraph.indentStart?.v ?? 0) + (paragraph.hanging?.v ?? 0)) * 15) : 720 * (level + 1)
        // Univer counts from one and adds startNumber as an offset.
        const start = Math.max(1, (source?.startNumber ?? 0) + 1)
        return `<w:lvl w:ilvl="${level}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${xml(text)}"/><w:pPr><w:ind w:left="${left}" w:hanging="${hanging}"/></w:pPr><w:rPr>${textStyle(source?.textStyle ?? {})}</w:rPr></w:lvl>`
      }).join('')
      return `<w:abstractNum w:abstractNumId="${list.id}"><w:multiLevelType w:val="multilevel"/>${levels}</w:abstractNum><w:num w:numId="${list.id}"><w:abstractNumId w:val="${list.id}"/></w:num>`
    }).join('')
    zip.file('word/numbering.xml', documentXml(numbering, 'numbering'))
    contentTypes.push('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>')
  }
  for (const part of secondaryParts) zip.file(`word/_rels/${part}.xml.rels`, `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`)
  zip.file('word/document.xml', documentXml(`<w:body>${body}<w:sectPr>${section}</w:sectPr></w:body>`))
  zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`)
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${[...new Set(contentTypes)].join('')}</Types>`)
  const { snapshot, page, headerFooter, footnotes, citations } = document
  return writeOfficeRoundTrip(zip, 'word', { snapshot, page, headerFooter, footnotes, citations })
}
