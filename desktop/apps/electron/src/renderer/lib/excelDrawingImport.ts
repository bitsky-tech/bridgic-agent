import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

interface DrawingAnchor { column: number; row: number; columnOffset: number; rowOffset: number }
export interface ImportedSheetTextBox { source: string; from: DrawingAnchor; to: DrawingAnchor }

/** Preview ordinary native text boxes without pretending Univer supports editable Office shapes. */
export async function importSheetTextBoxes(archive: JSZip, sheets: Map<number, { path: string }>): Promise<Map<number, ImportedSheetTextBox[]>> {
  const result = new Map<number, ImportedSheetTextBox[]>()
  const parser = new DOMParser()
  const serializer = new XMLSerializer()
  const children = (node: Element, name: string) => Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1 && (child as Element).localName === name)
  const descendants = (node: Element, name: string) => Array.from(node.getElementsByTagName('*')).filter((child) => child.localName === name)
  const context = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d')
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const wrapText = (text: string, width: number, size: number, font: string, wrap: boolean): string[] => {
    if (context) context.font = font
    const measure = (value: string) => {
      if (context) return context.measureText(value).width
      return Array.from(value).reduce((sum, character) => {
        if (/\s/.test(character)) return sum + size * 0.33
        return sum + size * (character.codePointAt(0)! > 255 ? 1 : 0.55)
      }, 0)
    }
    const lines: string[] = []
    for (const explicitLine of text.replace(/\r\n?/g, '\n').split('\n')) {
      if (!wrap) { lines.push(explicitLine); continue }
      let line = ''
      for (const { segment } of graphemes.segment(explicitLine)) {
        if (line && measure(line + segment) > width) {
          const boundary = Math.max(line.lastIndexOf(' '), line.lastIndexOf('\t'))
          if (boundary > 0) {
            lines.push(line.slice(0, boundary).trimEnd())
            line = line.slice(boundary + 1) + segment
          } else {
            lines.push(line.trimEnd())
            line = segment.trimStart()
          }
        } else line += segment
      }
      lines.push(line)
    }
    return lines
  }
  const themeFile = archive.file('xl/theme/theme1.xml')
  const theme = themeFile ? parser.parseFromString(await themeFile.async('text'), 'text/xml') : undefined
  const scheme = theme && descendants(theme.documentElement, 'clrScheme')[0]
  const fillColor = (fill: Element | undefined, fallback: string) => {
    if (!fill) return fallback
    const color = children(fill, 'srgbClr')[0] ?? children(fill, 'schemeClr')[0] ?? children(fill, 'sysClr')[0]
    if (!color) return fallback
    let hex = color.getAttribute('val') ?? ''
    if (color.localName === 'schemeClr') {
      const entry = scheme && children(scheme, hex)[0]
      const rgb = entry && children(entry, 'srgbClr')[0]
      const system = entry && children(entry, 'sysClr')[0]
      hex = rgb?.getAttribute('val') ?? system?.getAttribute('lastClr') ?? ''
    } else if (color.localName === 'sysClr') hex = color.getAttribute('lastClr') ?? ''
    if (!/^[0-9a-f]{6}$/i.test(hex)) return fallback
    const mod = Number(children(color, 'lumMod')[0]?.getAttribute('val') ?? 100000) / 100000
    const off = Number(children(color, 'lumOff')[0]?.getAttribute('val') ?? 0) / 100000
    return `#${[0, 2, 4].map((offset) => Math.round(Math.min(255, Math.max(0, parseInt(hex.slice(offset, offset + 2), 16) * mod + 255 * off))).toString(16).padStart(2, '0')).join('')}`
  }
  const pathFor = (part: string, target: string) => {
    const parts: string[] = []
    for (const segment of (target.startsWith('/') ? target.slice(1) : `${part.slice(0, part.lastIndexOf('/') + 1)}${target}`).split('/')) {
      if (segment === '..') parts.pop()
      else if (segment && segment !== '.') parts.push(segment)
    }
    return parts.join('/')
  }
  for (const [sheetId, sheet] of sheets) {
    const relsPath = sheet.path.replace(/\/([^/]+)$/, '/_rels/$1.rels')
    const relsFile = archive.file(relsPath)
    if (!relsFile) continue
    const rels = parser.parseFromString(await relsFile.async('text'), 'text/xml')
    const boxes: ImportedSheetTextBox[] = []
    for (const rel of Array.from(rels.getElementsByTagName('*'))) {
      if (!rel.getAttribute('Type')?.endsWith('/drawing') || rel.getAttribute('TargetMode') === 'External') continue
      const file = archive.file(pathFor(sheet.path, rel.getAttribute('Target') ?? ''))
      if (!file) continue
      const drawing = parser.parseFromString(await file.async('text'), 'text/xml')
      for (const anchor of Array.from(drawing.documentElement.childNodes).filter((node): node is Element => node.nodeType === 1)) {
        const shape = children(anchor, 'sp')[0]
        const body = shape && children(shape, 'txBody')[0]
        const from = children(anchor, 'from')[0]
        const to = children(anchor, 'to')[0]
        if (!shape || !body || !from) continue
        const marker = (node: Element): DrawingAnchor => ({
          column: Number(children(node, 'col')[0]?.textContent ?? 0), row: Number(children(node, 'row')[0]?.textContent ?? 0),
          columnOffset: Number(children(node, 'colOff')[0]?.textContent ?? 0) / 9525, rowOffset: Number(children(node, 'rowOff')[0]?.textContent ?? 0) / 9525,
        })
        const extent = descendants(shape, 'ext')[0]
        const width = Number(extent?.getAttribute('cx')) / 9525
        const height = Number(extent?.getAttribute('cy')) / 9525
        if (!(width > 0 && height > 0)) continue
        const svg = parser.parseFromString('<svg xmlns="http://www.w3.org/2000/svg"/>', 'text/xml')
        svg.documentElement.setAttribute('width', String(width))
        svg.documentElement.setAttribute('height', String(height))
        svg.documentElement.setAttribute('viewBox', `0 0 ${width} ${height}`)
        const properties = children(shape, 'spPr')[0]
        const line = properties && children(properties, 'ln')[0]
        const background = svg.createElementNS('http://www.w3.org/2000/svg', 'rect')
        background.setAttribute('width', String(width))
        background.setAttribute('height', String(height))
        background.setAttribute('fill', fillColor(properties && children(properties, 'solidFill')[0], 'none'))
        background.setAttribute('stroke', fillColor(line && children(line, 'solidFill')[0], 'none'))
        background.setAttribute('stroke-width', String(Number(line?.getAttribute('w') || 9525) / 9525))
        svg.documentElement.appendChild(background)
        const bodyProperties = children(body, 'bodyPr')[0]
        const inset = (name: string, fallback: number) => Number(bodyProperties?.getAttribute(name) || fallback) / 9525
        const left = inset('lIns', 91440)
        const right = inset('rIns', 91440)
        const top = inset('tIns', 45720)
        const bottom = inset('bIns', 45720)
        const fontScale = Number(bodyProperties && children(bodyProperties, 'normAutofit')[0]?.getAttribute('fontScale') || 100000) / 100000
        const lines: Array<{ text: string; x: number; y: number; size: number; font: string; alignment?: string | null; properties?: Element }> = []
        let y = 0
        for (const paragraph of children(body, 'p')) {
          const text = Array.from(paragraph.childNodes).filter((child): child is Element => child.nodeType === 1)
            .map((child) => child.localName === 'br' ? '\n' : descendants(child, 't').map((run) => run.textContent ?? '').join('')).join('')
          const properties = descendants(paragraph, 'rPr')[0] ?? descendants(paragraph, 'defRPr')[0]
          const size = Number(properties?.getAttribute('sz') || 1100) / 75 * fontScale
          const family = properties && (children(properties, 'latin')[0]?.getAttribute('typeface') || children(properties, 'ea')[0]?.getAttribute('typeface')) || 'Arial'
          const font = `${properties?.getAttribute('b') === '1' ? 'bold ' : ''}${size}px "${family}", sans-serif`
          const paragraphProperties = children(paragraph, 'pPr')[0]
          const alignment = paragraphProperties?.getAttribute('algn')
          const marginLeft = Number(paragraphProperties?.getAttribute('marL') || 0) / 9525
          const marginRight = Number(paragraphProperties?.getAttribute('marR') || 0) / 9525
          const available = Math.max(1, width - left - right - marginLeft - marginRight)
          const spacing = paragraphProperties && children(paragraphProperties, 'lnSpc')[0]
          const points = spacing && children(spacing, 'spcPts')[0]
          const percent = spacing && children(spacing, 'spcPct')[0]
          const lineHeight = points ? Number(points.getAttribute('val')) / 75 : size * Number(percent?.getAttribute('val') || 125000) / 100000
          const paragraphSpacing = (name: string) => {
            const spacing = paragraphProperties && children(paragraphProperties, name)[0]
            return spacing ? Number(children(spacing, 'spcPts')[0]?.getAttribute('val') || 0) / 75 : 0
          }
          y += paragraphSpacing('spcBef')
          let x = left + marginLeft
          if (alignment === 'ctr') x += available / 2
          else if (alignment === 'r') x += available
          for (const lineText of wrapText(text, available, size, font, bodyProperties?.getAttribute('wrap') !== 'none')) {
            lines.push({ text: lineText, x, y: y + size, size, font: `"${family}", sans-serif`, alignment, properties })
            y += lineHeight
          }
          y += paragraphSpacing('spcAft')
        }
        let verticalOffset = top
        if (bodyProperties?.getAttribute('anchor') === 'ctr') verticalOffset += Math.max(0, (height - top - bottom - y) / 2)
        else if (bodyProperties?.getAttribute('anchor') === 'b') verticalOffset += Math.max(0, height - top - bottom - y)
        for (const { text, x, y, size, font, alignment, properties } of lines) {
          const node = svg.createElementNS('http://www.w3.org/2000/svg', 'text')
          node.setAttribute('x', String(x))
          if (alignment === 'ctr') node.setAttribute('text-anchor', 'middle')
          else if (alignment === 'r') node.setAttribute('text-anchor', 'end')
          node.setAttribute('y', String(verticalOffset + y))
          node.setAttribute('font-family', font)
          node.setAttribute('font-size', String(size))
          node.setAttribute('xml:space', 'preserve')
          node.setAttribute('fill', fillColor(properties && children(properties, 'solidFill')[0], '#000000'))
          if (properties?.getAttribute('b') === '1') node.setAttribute('font-weight', 'bold')
          node.appendChild(svg.createTextNode(text))
          svg.documentElement.appendChild(node)
        }
        const bytes = new TextEncoder().encode(serializer.serializeToString(svg))
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
        const start = marker(from)
        const end = to ? marker(to) : { ...start, columnOffset: start.columnOffset + width, rowOffset: start.rowOffset + height }
        boxes.push({ source: `data:image/svg+xml;base64,${btoa(binary)}`, from: start, to: end })
      }
    }
    if (boxes.length) result.set(sheetId, boxes)
  }
  return result
}
