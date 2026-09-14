import { presentationChartBlankDisplay } from './presentationCharts'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { PresentationElement } from '@/atoms/presentation'
import { isPresentationChartElement, isPresentationTableElement } from './presentationInsert'

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** Graphic frames need a group transform; their own p:xfrm cannot express flips. */
export function correctPresentationGraphicFlips(xml: string, elements: readonly PresentationElement[]): string {
  const flipped = new Map(elements.filter(element => (isPresentationChartElement(element) || isPresentationTableElement(element))
    && (element.flipHorizontal || element.flipVertical)).map(element => [element.id, element]))
  if (!flipped.size) return xml
  const document = new DOMParser().parseFromString(xml, 'text/xml')
  let nextId = Array.from(document.getElementsByTagNameNS(P, 'cNvPr')).reduce((max, node) => Math.max(max, Number(node.getAttribute('id')) || 0), 0) + 1
  for (const frame of Array.from(document.getElementsByTagNameNS(P, 'graphicFrame'))) {
    const element = flipped.get(frame.getElementsByTagNameNS(P, 'cNvPr')[0]?.getAttribute('name') ?? '')
    const transform = frame.getElementsByTagNameNS(P, 'xfrm')[0]
    if (!element || !transform || !frame.parentNode) continue
    const group = document.createElementNS(P, 'p:grpSp')
    const nonvisual = document.createElementNS(P, 'p:nvGrpSpPr')
    const name = document.createElementNS(P, 'p:cNvPr')
    name.setAttribute('id', String(nextId++))
    name.setAttribute('name', `Flipped ${element.id}`)
    nonvisual.appendChild(name)
    nonvisual.appendChild(document.createElementNS(P, 'p:cNvGrpSpPr'))
    nonvisual.appendChild(document.createElementNS(P, 'p:nvPr'))
    group.appendChild(nonvisual)
    const properties = document.createElementNS(P, 'p:grpSpPr')
    const groupTransform = document.createElementNS(A, 'a:xfrm')
    if (element.flipHorizontal) groupTransform.setAttribute('flipH', '1')
    if (element.flipVertical) groupTransform.setAttribute('flipV', '1')
    for (const [tag, sourceTag, attributes] of [
      ['off', 'off', ['x', 'y']], ['ext', 'ext', ['cx', 'cy']],
      ['chOff', 'off', ['x', 'y']], ['chExt', 'ext', ['cx', 'cy']],
    ] as const) {
      const node = document.createElementNS(A, `a:${tag}`)
      const source = transform.getElementsByTagNameNS(A, sourceTag)[0]
      for (const attr of attributes) node.setAttribute(attr, source?.getAttribute(attr) ?? '0')
      groupTransform.appendChild(node)
    }
    properties.appendChild(groupTransform)
    group.appendChild(properties)
    frame.parentNode.replaceChild(group, frame)
    group.appendChild(frame)
  }
  return new XMLSerializer().serializeToString(document)
}

/** Preserve missing values and real zeros in the cache and its editable workbook. */
export async function correctPresentationChartData(archive: JSZip, xml: string, slideNumber: number, elements: readonly PresentationElement[]): Promise<void> {
  const charts = new Map(elements.filter(isPresentationChartElement)
    .filter(element => Array.isArray(element.categories) && Array.isArray(element.series))
    .filter(element => element.displayBlanksAs === 'zero' || element.series.some(series => series && Array.isArray(series.values) && element.categories.some((_, index) => series.values[index] == null || series.values[index] === 0)))
    .map(element => [element.id, element]))
  if (!charts.size) return
  const parse = (value: string) => new DOMParser().parseFromString(value, 'text/xml')
  const serialize = (value: ReturnType<typeof parse>) => new XMLSerializer().serializeToString(value)
  const resolve = (source: string, target: string) => new URL(target, `https://package/${source}`).pathname.slice(1)
  const slidePath = `ppt/slides/slide${slideNumber}.xml`
  const relationships = archive.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`)
  if (!relationships) return
  const rels = parse(await relationships.async('text'))
  const targets = new Map(Array.from(rels.getElementsByTagName('Relationship')).map(node => [node.getAttribute('Id'), node.getAttribute('Target')!]))
  for (const frame of Array.from(parse(xml).getElementsByTagNameNS(P, 'graphicFrame'))) {
    const element = charts.get(frame.getElementsByTagNameNS(P, 'cNvPr')[0]?.getAttribute('name') ?? '')
    const id = frame.getElementsByTagNameNS(C, 'chart')[0]?.getAttributeNS(R, 'id')
    const target = id ? targets.get(id) : undefined
    if (!element || !target) continue
    const chartPath = resolve(slidePath, target)
    const chart = parse(await archive.file(chartPath)!.async('text'))
    // PptxGenJS accepts gap/span but otherwise rewrites the valid OOXML zero mode.
    chart.getElementsByTagNameNS(C, 'dispBlanksAs')[0]?.setAttribute('val', presentationChartBlankDisplay(element.displayBlanksAs))
    const sourceSeries = element.series.filter(series => series && typeof series.name === 'string' && Array.isArray(series.values))
    const blankCells = new Set<string>()
    const zeroCells = new Set<string>()
    Array.from(chart.getElementsByTagNameNS(C, 'ser')).forEach((series, index) => {
      const values = sourceSeries[index]?.values
      if (!values) return
      const data = series.getElementsByTagNameNS(C, 'val')[0]
      if (!data) return
      const formula = data.getElementsByTagNameNS(C, 'f')[0]?.textContent ?? ''
      const address = /!\$([A-Z]+)\$(\d+)/.exec(formula)
      for (const point of Array.from(data.getElementsByTagNameNS(C, 'pt'))) {
        const pointIndex = Number(point.getAttribute('idx'))
        const cell = address ? `${address[1]}${Number(address[2]) + pointIndex}` : undefined
        if (values[pointIndex] == null) {
          point.parentNode?.removeChild(point)
          if (cell) blankCells.add(cell)
        } else if (values[pointIndex] === 0 && cell) zeroCells.add(cell)
      }
    })
    archive.file(chartPath, serialize(chart))
    if (!blankCells.size && !zeroCells.size) continue
    const relationPath = chartPath.replace(/([^/]+)$/, '_rels/$1.rels')
    const chartRels = parse(await archive.file(relationPath)!.async('text'))
    const workbookId = chart.getElementsByTagNameNS(C, 'externalData')[0]?.getAttributeNS(R, 'id')
    const workbookTarget = Array.from(chartRels.getElementsByTagName('Relationship')).find(node => node.getAttribute('Id') === workbookId)?.getAttribute('Target')
    if (!workbookTarget) continue
    const workbookPath = resolve(chartPath, workbookTarget)
    const workbook = await JSZip.loadAsync(await archive.file(workbookPath)!.async('uint8array'))
    const sheetPath = 'xl/worksheets/sheet1.xml'
    const sheet = parse(await workbook.file(sheetPath)!.async('text'))
    for (const cell of Array.from(sheet.getElementsByTagName('c'))) {
      const address = cell.getAttribute('r') ?? ''
      if (blankCells.has(address)) cell.parentNode?.removeChild(cell)
      else if (zeroCells.has(address)) {
        const value = cell.getElementsByTagName('v')[0] ?? cell.appendChild(sheet.createElementNS(sheet.documentElement.namespaceURI!, 'v'))
        value.textContent = '0'
      }
    }
    workbook.file(sheetPath, serialize(sheet))
    archive.file(workbookPath, await workbook.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
  }
}
