import { expect, it } from 'bun:test'
import { DOMParser } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { importSheetTextBoxes } from '../excelDrawingImport'

it('preserves explicit breaks, blank lines and wraps long English and CJK text inside the box', async () => {
  const archive = new JSZip()
  archive.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Type="office/drawing" Target="../drawings/drawing1.xml"/></Relationships>')
  const text = '这是一个需要自动换行的中文说明，同时有 very long English words and notes.'
  archive.file('xl/drawings/drawing1.xml', `<wsDr><oneCellAnchor><from><col>0</col><row>0</row></from>
    <sp><spPr><xfrm><ext cx="1333500" cy="2857500"/></xfrm></spPr><txBody><bodyPr wrap="square" lIns="0" rIns="0"/>
    <p><r><t>First line</t></r><br/><br/><r><t>Second line</t></r></p><p><r><t>${text}</t></r></p></txBody></sp></oneCellAnchor></wsDr>`)
  const box = (await importSheetTextBoxes(archive, new Map([[1, { path: 'xl/worksheets/sheet1.xml' }]]))).get(1)![0]!
  const svg = new DOMParser().parseFromString(Buffer.from(box.source.split(',')[1]!, 'base64').toString(), 'text/xml')
  const lines = Array.from(svg.getElementsByTagName('text'))
  expect(lines.slice(0, 3).map((line) => line.textContent)).toEqual(['First line', '', 'Second line'])
  expect(lines.length).toBeGreaterThan(5)
  expect(lines.slice(3).map((line) => line.textContent).join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  expect(lines.every((line, index) => !index || Number(line.getAttribute('y')) > Number(lines[index - 1]!.getAttribute('y')))).toBe(true)
  expect(Number(lines.at(-1)!.getAttribute('y'))).toBeLessThan(300)
  archive.file('xl/drawings/drawing1.xml', (await archive.file('xl/drawings/drawing1.xml')!.async('text')).replace('wrap="square"', 'wrap="none"'))
  const unwrapped = (await importSheetTextBoxes(archive, new Map([[1, { path: 'xl/worksheets/sheet1.xml' }]]))).get(1)![0]!
  const unwrappedSvg = new DOMParser().parseFromString(Buffer.from(unwrapped.source.split(',')[1]!, 'base64').toString(), 'text/xml')
  expect(Array.from(unwrappedSvg.getElementsByTagName('text')).map((line) => line.textContent)).toEqual(['First line', '', 'Second line', text])
})

it('previews native text boxes with their anchors and XML-escaped text without loading external parts', async () => {
  const archive = new JSZip()
  archive.file('xl/worksheets/_rels/sheet1.xml.rels', `<Relationships>
    <Relationship Type="office/drawing" Target="../drawings/drawing1.xml"/>
    <Relationship Type="office/drawing" Target="https://example.com/drawing.xml" TargetMode="External"/>
  </Relationships>`)
  archive.file('xl/drawings/drawing1.xml', `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
    <xdr:twoCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:sp><xdr:spPr><a:xfrm><a:ext cx="1905000" cy="952500"/></a:xfrm></xdr:spPr>
    <xdr:txBody><a:p><a:r><a:rPr sz="1500" b="1"/><a:t>R&amp;D &lt;计划&gt;</a:t></a:r></a:p></xdr:txBody></xdr:sp></xdr:twoCellAnchor>
  </xdr:wsDr>`)
  const boxes = await importSheetTextBoxes(archive, new Map([[7, { path: 'xl/worksheets/sheet1.xml' }]]))
  const box = boxes.get(7)![0]!
  expect(boxes.size).toBe(1)
  expect(boxes.get(7)).toHaveLength(1)
  expect(box.from).toEqual({ column: 2, row: 3, columnOffset: 10, rowOffset: 2 })
  expect(box.to).toEqual({ column: 5, row: 8, columnOffset: 0, rowOffset: 0 })
  const svg = Buffer.from(box.source.split(',')[1]!, 'base64').toString('utf8')
  expect(svg).toContain('width="200"')
  expect(svg).toContain('font-size="20"')
  expect(svg).toContain('font-weight="bold"')
  expect(svg).toContain('R&amp;D &lt;计划&gt;')
})

it('previews one-cell text boxes with native size, theme background and paragraph alignment', async () => {
  const archive = new JSZip()
  archive.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Type="office/drawing" Target="../drawings/drawing1.xml"/></Relationships>')
  archive.file('xl/theme/theme1.xml', '<theme><clrScheme><accent1> <srgbClr val="336699"/></accent1></clrScheme></theme>')
  archive.file('xl/drawings/drawing1.xml', `<wsDr><oneCellAnchor>
    <from><col>3</col><colOff>9525</colOff><row>15</row><rowOff>19050</rowOff></from>
    <sp><spPr><xfrm><ext cx="1905000" cy="476250"/></xfrm><solidFill><schemeClr val="accent1"><lumMod val="20000"/><lumOff val="80000"/></schemeClr></solidFill></spPr>
    <txBody><p><pPr algn="ctr"/><r><t>Caption</t></r></p></txBody></sp>
  </oneCellAnchor></wsDr>`)
  const box = (await importSheetTextBoxes(archive, new Map([[1, { path: 'xl/worksheets/sheet1.xml' }]]))).get(1)![0]!
  expect(box.from).toEqual({ column: 3, row: 15, columnOffset: 1, rowOffset: 2 })
  expect(box.to).toEqual({ column: 3, row: 15, columnOffset: 201, rowOffset: 52 })
  const svg = Buffer.from(box.source.split(',')[1]!, 'base64').toString('utf8')
  expect(svg).toContain('fill="#d6e0eb"')
  expect(svg).toContain('text-anchor="middle"')
  expect(svg).toContain('Caption')
})
