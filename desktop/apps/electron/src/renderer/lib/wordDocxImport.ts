import mammoth from 'mammoth'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { PageOrientType } from '@univerjs/core'
import type { WordDocumentState } from './wordDomain'
import type { WordHeaderFooterHtmlVariant, WordHtmlSection } from './wordUniverModel'
import { readOfficeRoundTrip } from './office/officeRoundTrip'

export type WordFileDocument = Pick<WordDocumentState, 'snapshot' | 'page' | 'headerFooter' | 'footnotes' | 'citations'>

export interface ImportedDocx {
  html: string
  warnings: string[]
  document?: WordFileDocument
  sourceProtected?: boolean
  layout?: Pick<WordFileDocument, 'page' | 'headerFooter'> & {
    headerFooterVariants?: WordHeaderFooterHtmlVariant[]
    evenAndOddHeaders?: boolean
    sections?: WordHtmlSection[]
  }
}

/** Convert DOCX OOXML bytes into sanitized-at-dispatch semantic HTML for Univer. */
export async function importDocxToHtml(bytes: Uint8Array): Promise<ImportedDocx> {
  if (bytes.byteLength === 0) throw new Error('The Word document is empty')
  const ownedBytes = new Uint8Array(bytes.byteLength)
  ownedBytes.set(bytes)
  const archive = await JSZip.loadAsync(ownedBytes)
  const stored = await readOfficeRoundTrip(archive, 'word') as Partial<WordFileDocument> | null
  const document = stored?.snapshot?.body && typeof stored.snapshot.body.dataStream === 'string'
    && stored.page && stored.headerFooter && Array.isArray(stored.footnotes) && Array.isArray(stored.citations)
    ? stored as WordFileDocument : undefined
  const parser = new DOMParser()
  const xml = parser.parseFromString(await archive.file('word/document.xml')!.async('text'), 'text/xml')
  const elements = (node: Document | Element, name: string) => Array.from(node.getElementsByTagName('*')).filter((element) => element.localName === name)
  const attribute = (node: Element | undefined, name: string) => node ? Array.from(node.attributes).find((item) => item.localName === name)?.value : undefined
  const enabled = (node: Element | undefined) => Boolean(node) && !['0', 'false', 'off'].includes(attribute(node, 'val')?.toLowerCase() ?? '')
  const partPath = (part: string, target: string) => {
    const segments = target.startsWith('/') ? [] : part.split('/').slice(0, -1)
    for (const segment of target.split('/')) {
      if (segment === '..') segments.pop()
      else if (segment && segment !== '.') segments.push(segment)
    }
    return segments.join('/')
  }
  const convertXml = async (copy: JSZip, source: Document) => {
    const part = source.cloneNode(true) as Document
    const prefix = `bridgic-word-import-${crypto.randomUUID()}-`
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const images = new Map<string, { alt: string; width: number; height: number }>()
    // Identify each image instance before conversion. Mammoth can skip drawings,
    // select AlternateContent fallbacks or move VML pictures outside paragraphs.
    for (const node of elements(part, 'inline').concat(elements(part, 'anchor'))) {
      if (!node.namespaceURI?.includes('wordprocessingDrawing')) continue
      const extent = elements(node, 'extent')[0]
      let properties = elements(node, 'docPr')[0]
      if (!properties) {
        properties = part.createElementNS(node.namespaceURI, 'wp:docPr')
        node.appendChild(properties)
      }
      const marker = `${prefix}image-${images.size}`
      images.set(marker, { alt: attribute(properties, 'descr') || attribute(properties, 'title') || '', width: Number(attribute(extent, 'cx')) / 9525, height: Number(attribute(extent, 'cy')) / 9525 })
      properties.setAttribute('descr', marker)
    }
    for (const node of elements(part, 'imagedata')) {
      if (node.namespaceURI !== 'urn:schemas-microsoft-com:vml') continue
      let shape = node.parentNode as Element | null
      while (shape && shape.localName !== 'shape') shape = shape.parentNode as Element | null
      const size = (name: string) => {
        const value = shape?.getAttribute('style')?.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)(pt|px|in|cm|mm)?`, 'i'))
        return value ? Number(value[1]) * ({ pt: 96 / 72, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[value[2]?.toLowerCase() ?? 'px'] ?? 1) : 0
      }
      const marker = `${prefix}image-${images.size}`
      images.set(marker, { alt: attribute(node, 'title') ?? '', width: size('width'), height: size('height') })
      const id = attribute(node, 'id')
      if (id) {
        // Mammoth does not map the Office namespace of VML's o:title. Convert
        // only this transient image node to DrawingML to carry its identity.
        const drawing = parser.parseFromString(`<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><wp:inline><wp:docPr id="${images.size}" name="Image" descr="${marker}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${escape(id)}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`, 'text/xml')
        node.parentNode!.replaceChild(part.importNode(drawing.documentElement, true), node)
      }
    }
    const fields = new Map<string, { instruction: string; display: string }>()
    const markField = (instruction: string, texts: Element[], end?: Element) => {
      if (!/^\s*(PAGE|NUMPAGES)\b/i.test(instruction)) return
      const marker = `${prefix}field-${fields.size}`
      fields.set(marker, { instruction: instruction.trim(), display: texts.map((node) => node.textContent ?? '').join('') || '1' })
      if (!texts.length && end) {
        const text = part.createElementNS(end.namespaceURI, 'w:t')
        if (end.localName === 'fldSimple') {
          const run = part.createElementNS(end.namespaceURI, 'w:r')
          run.appendChild(text)
          end.appendChild(run)
        } else end.parentNode!.appendChild(text)
        texts.push(text)
      }
      texts.forEach((node, index) => { node.textContent = index === 0 ? marker : '' })
    }
    for (const node of elements(part, 'fldSimple')) {
      const instruction = attribute(node, 'instr') ?? ''
      if (!/^\s*(PAGE|NUMPAGES)\b/i.test(instruction)) continue
      markField(instruction, elements(node, 't'), node)
      // Mammoth ignores fldSimple rather than traversing its cached result.
      const parent = node.parentNode!
      for (const child of Array.from(node.childNodes)) parent.insertBefore(child, node)
      parent.removeChild(node)
    }
    const stack: Array<{ instruction: string; texts: Element[]; separated: boolean }> = []
    for (const node of Array.from(part.getElementsByTagName('*'))) {
      if (node.localName === 'fldChar') {
        const type = attribute(node, 'fldCharType')
        if (type === 'begin') stack.push({ instruction: '', texts: [], separated: false })
        else if (type === 'separate' && stack.length) stack.at(-1)!.separated = true
        else if (type === 'end' && stack.length) {
          const field = stack.pop()!
          markField(field.instruction, field.texts, node)
        }
      } else if (node.localName === 'instrText' && stack.length && !stack.at(-1)!.separated) stack.at(-1)!.instruction += node.textContent ?? ''
      else if (node.localName === 't' && stack.at(-1)?.separated) stack.at(-1)!.texts.push(node)
    }
    copy.file('word/document.xml', new XMLSerializer().serializeToString(part))
    const data = await copy.generateAsync({ type: 'arraybuffer' })
    const converted = await mammoth.convertToHtml(typeof Buffer === 'undefined' ? { arrayBuffer: data } : { buffer: Buffer.from(data) })
    let html = converted.value.replace(/<img\b[^>]*>/g, (tag) => {
      const marker = tag.match(/\balt="([^"]*)"/)?.[1]
      const image = marker && images.get(marker)
      if (!image) return tag
      const restored = tag.replace(/\s+alt="[^"]*"/, image.alt ? ` alt="${escape(image.alt)}"` : '')
      return image.width > 0 && image.height > 0 ? restored.replace(/\s*\/?>(?:$)/, ` width="${image.width}" height="${image.height}" />`) : restored
    })
    for (const [marker, field] of fields) html = html.replace(marker, `<span data-word-field="${field.instruction.match(/^\w+/)![0]!.toUpperCase()}" data-word-field-instruction="${escape(field.instruction)}">${escape(field.display)}</span>`)
    return { ...converted, value: html }
  }
  const result = await convertXml(await JSZip.loadAsync(ownedBytes), xml)
  const children = (node: Element, name: string) => Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1 && (child as Element).localName === name)
  const mainBody = elements(xml, 'body')[0]!
  // Paragraph-level sectPr ends that section; missing references inherit independently.
  // Ignore sectPr nested in revision history rather than selecting the last descendant.
  const sectionNodes: Array<Element | undefined> = children(mainBody, 'p').flatMap((paragraph) => {
    const properties = children(paragraph, 'pPr')[0]
    return properties ? children(properties, 'sectPr') : []
  })
  sectionNodes.push(children(mainBody, 'sectPr')[0])
  const section = sectionNodes[0]
  const size = section && children(section, 'pgSz')[0]
  const margins = section && children(section, 'pgMar')[0]
  const pageNumberStart = Number(attribute(section ? children(section, 'pgNumType')[0] : undefined, 'start'))
  const warnings = result.messages.map((message) => message.message)
  let marginPreset: WordFileDocument['page']['margins'] = 'normal'
  const leftMargin = Number(attribute(margins, 'left'))
  if (leftMargin <= 760) marginPreset = 'narrow'
  else if (leftMargin >= 2000) marginPreset = 'wide'
  const layout: NonNullable<ImportedDocx['layout']> = {
    page: {
      size: Math.min(Number(attribute(size, 'w')), Number(attribute(size, 'h'))) === 12240 ? 'letter' : 'a4',
      orientation: attribute(size, 'orient') === 'landscape' || Number(attribute(size, 'w')) > Number(attribute(size, 'h')) ? 'landscape' : 'portrait',
      margins: marginPreset,
    },
    headerFooter: {
      headerHtml: '', footerHtml: '', showPageNumbers: false,
      differentFirstPage: enabled(section ? children(section, 'titlePg')[0] : undefined),
      pageNumberStart: Number.isInteger(pageNumberStart) && pageNumberStart > 0 ? pageNumberStart : 1,
    },
    headerFooterVariants: [],
  }
  const relsFile = archive.file('word/_rels/document.xml.rels')
  const rels = relsFile ? parser.parseFromString(await relsFile.async('text'), 'text/xml') : undefined
  const relationships = rels ? elements(rels, 'Relationship') : []
  const settingsTarget = relationships.find((node) => node.getAttribute('Type')?.endsWith('/settings') && node.getAttribute('TargetMode') !== 'External')?.getAttribute('Target')
  const settingsFile = settingsTarget ? archive.file(partPath('word/document.xml', settingsTarget)) : archive.file('word/settings.xml')
  const settingsXml = settingsFile ? parser.parseFromString(await settingsFile.async('text'), 'text/xml') : undefined
  layout.evenAndOddHeaders = enabled(settingsXml ? elements(settingsXml, 'evenAndOddHeaders')[0] : undefined)
  const inherited = new Map<string, Element>()
  const sectionReferences = sectionNodes.map((node) => {
    for (const reference of node ? [...children(node, 'headerReference'), ...children(node, 'footerReference')] : []) {
      inherited.set(`${reference.localName}:${attribute(reference, 'type')}`, reference)
    }
    return new Map(inherited)
  })
  const convertedParts = new Map<string, { id: string; html: string }>()
  const referenceParts = new Map<Element, WordHeaderFooterHtmlVariant>()
  for (const reference of new Set(sectionReferences.flatMap((refs) => [...refs.values()]))) {
    const kind = reference.localName === 'headerReference' ? 'header' : 'footer'
    const variant = attribute(reference, 'type')
    if (variant !== 'default' && variant !== 'first' && variant !== 'even') continue
    const id = attribute(reference, 'id')
    const relationship = relationships.find((node) => node.getAttribute('Id') === id && node.getAttribute('TargetMode') !== 'External')
    const target = relationship?.getAttribute('Target')
    const path = target ? partPath('word/document.xml', target) : undefined
    const part = path && archive.file(path)
    if (!part) continue
    const key = `${kind}:${path}`
    const existing = convertedParts.get(key)
    if (existing) { referenceParts.set(reference, { kind, variant, ...existing }); continue }
    const partXml = parser.parseFromString(await part.async('text'), 'text/xml')
    // Reuse Mammoth for header/footer runs, tables and media instead of a text-only parser.
    const doc = parser.parseFromString('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>', 'text/xml')
    const body = doc.documentElement.firstChild!
    for (const attr of Array.from(partXml.documentElement.attributes)) doc.documentElement.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
    for (const child of Array.from(partXml.documentElement.childNodes)) body.appendChild(doc.importNode(child, true))
    const copy = await JSZip.loadAsync(ownedBytes)
    const partRels = archive.file(path!.replace(/\/([^/]+)$/, '/_rels/$1.rels'))
    const partRelationships = parser.parseFromString(partRels ? await partRels.async('text') : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', 'text/xml')
    // Mammoth reads the temporary part as word/document.xml. Rebase embedded
    // media relationships so nested parts keep their original package targets.
    for (const rel of elements(partRelationships, 'Relationship')) {
      if (rel.getAttribute('TargetMode') !== 'External' && rel.getAttribute('Target')) rel.setAttribute('Target', `/${partPath(path!, rel.getAttribute('Target')!)}`)
    }
    copy.file('word/_rels/document.xml.rels', new XMLSerializer().serializeToString(partRelationships))
    const converted = await convertXml(copy, doc)
    const html = converted.value
    const parsed = { id: `bridgic-word-${kind}-part-${convertedParts.size + 1}`, html }
    convertedParts.set(key, parsed)
    referenceParts.set(reference, { kind, variant, ...parsed })
    warnings.push(...converted.messages.map((message) => message.message))
  }
  for (const reference of sectionReferences[0]!.values()) {
    const part = referenceParts.get(reference)
    if (!part) continue
    if (part.variant === 'default') layout.headerFooter[`${part.kind}Html`] = part.html
    else layout.headerFooterVariants!.push({ kind: part.kind, variant: part.variant, html: part.html })
  }
  let html = result.value
  let chunks = [html]
  if (!document && sectionNodes.length > 1) {
    // A temporary marker lets Mammoth retain its full body conversion (including
    // lists/tables/media) while giving us exact section boundaries in that HTML.
    const marked = xml.cloneNode(true) as Document
    const markedBody = elements(marked, 'body')[0]!
    const marker = `bridgic-word-section-${crypto.randomUUID()}`
    for (const paragraph of children(markedBody, 'p')) {
      const properties = children(paragraph, 'pPr')[0]
      if (!properties || !children(properties, 'sectPr').length) continue
      const node = marked.createElementNS(paragraph.namespaceURI, 'w:p')
      const run = marked.createElementNS(paragraph.namespaceURI, 'w:r')
      const text = marked.createElementNS(paragraph.namespaceURI, 'w:t')
      text.appendChild(marked.createTextNode(marker))
      run.appendChild(text); node.appendChild(run)
      markedBody.insertBefore(node, paragraph.nextSibling)
    }
    const copy = await JSZip.loadAsync(ownedBytes)
    const converted = await convertXml(copy, marked)
    chunks = converted.value.split(`<p>${marker}</p>`)
    if (chunks.length !== sectionNodes.length) throw new Error('The Word section boundaries could not be imported')
    html = chunks.join('')
    warnings.push(...converted.messages.map((message) => message.message))
  }
  if (!document) {
    const styleKeys = {
      'header:default': 'defaultHeaderId', 'header:first': 'firstPageHeaderId', 'header:even': 'evenPageHeaderId',
      'footer:default': 'defaultFooterId', 'footer:first': 'firstPageFooterId', 'footer:even': 'evenPageFooterId',
    } as const
    const sectionTypes = new Map<string, WordHtmlSection['style']['sectionType']>([['continuous', 1], ['evenPage', 3], ['oddPage', 4]])
    layout.sections = sectionNodes.map((node, index) => {
      const parts = [...sectionReferences[index]!.values()].flatMap((reference) => referenceParts.get(reference) ?? [])
      const style: WordHtmlSection['style'] = {
        useFirstPageHeaderFooter: enabled(node ? children(node, 'titlePg')[0] : undefined) ? 1 : 0,
        evenAndOddHeaders: layout.evenAndOddHeaders ? 1 : 0,
        sectionType: sectionTypes.get(attribute(node ? children(node, 'type')[0] : undefined, 'val') ?? '') ?? 2,
      }
      const size = node ? children(node, 'pgSz')[0] : undefined
      const width = Number(attribute(size, 'w'))
      const height = Number(attribute(size, 'h'))
      if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        // Univer lays out the actual dimensions; orientation is retained for OOXML export.
        style.pageSize = { width: width / 15, height: height / 15 }
        style.pageOrient = attribute(size, 'orient') === 'landscape' || width > height ? PageOrientType.LANDSCAPE : PageOrientType.PORTRAIT
      }
      for (const [key, field] of Object.entries(styleKeys)) style[field] = parts.find((part) => `${part.kind}:${part.variant}` === key)?.id ?? ''
      const start = Number(attribute(node ? children(node, 'pgNumType')[0] : undefined, 'start'))
      if (Number.isInteger(start) && start > 0) style.pageNumberStart = start
      const format = attribute(node ? children(node, 'pgNumType')[0] : undefined, 'fmt')
      if (format === 'lowerRoman' || format === 'upperRoman' || format === 'lowerLetter' || format === 'upperLetter') style.pageNumberFormat = format
      else if (format === 'decimal') style.pageNumberFormat = 'decimal'
      const margin = node ? children(node, 'pgMar')[0] : undefined
      for (const [name, field] of [['top', 'marginTop'], ['bottom', 'marginBottom'], ['left', 'marginLeft'], ['right', 'marginRight'], ['header', 'marginHeader'], ['footer', 'marginFooter']] as const) {
        const value = attribute(margin, name)
        if (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0) style[field] = Number(value) / 15
      }
      return { html: chunks[index]!.trim() || '<p><br></p>', style, parts }
    })
  }
  return {
    html: html.trim() || '<p><br></p>',
    warnings: [...new Set(warnings)],
    document,
    layout,
    sourceProtected: !document,
  }
}
