import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import JSZip from 'jszip'

import { importDocxToHtml } from '../wordDocxImport'

describe('importDocxToHtml', () => {
  it('retains simple and complex page fields even without cached results', async () => {
    const fixture = resolve(import.meta.dir, '../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
    const archive = await JSZip.loadAsync(await Bun.file(fixture).arrayBuffer())
    archive.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p/><w:sectPr><w:footerReference w:type="default" r:id="footer"/></w:sectPr></w:body></w:document>')
    archive.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="footer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer.xml"/></Relationships>')
    archive.file('word/footer.xml', '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:fldSimple w:instr="PAGE"/><w:r><w:t> of </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>')
    const imported = await importDocxToHtml(await archive.generateAsync({ type: 'uint8array' }))
    expect(imported.layout?.headerFooter.footerHtml).toBe('<p><span data-word-field="PAGE" data-word-field-instruction="PAGE">1</span> of <span data-word-field="NUMPAGES" data-word-field-instruction="NUMPAGES">1</span></p>')
    expect(imported.warnings).toEqual([])
  })

  it.each(['', '0', 'false', 'off'] as const)('imports all header/footer variants and respects OOXML on/off values (%s)', async (value) => {
    const fixture = resolve(import.meta.dir, '../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
    const archive = await JSZip.loadAsync(await Bun.file(fixture).arrayBuffer())
    const parts = (['header', 'footer'] as const).flatMap((kind) => (['default', 'first', 'even'] as const).map((variant) => ({ kind, variant, id: `${kind}-${variant}` })))
    const flag = value ? ` w:val="${value}"` : ''
    archive.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p/><w:sectPr>${parts.map(({ kind, variant, id }) => `<w:${kind}Reference w:type="${variant}" r:id="${id}"/>`).join('')}<w:titlePg${flag}/><w:pgNumType w:start="4"/></w:sectPr></w:body></w:document>`)
    archive.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.map(({ kind, id }) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${id}.xml"/>`).join('')}<Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="config/settings.xml"/></Relationships>`)
    for (const { kind, id } of parts) archive.file(`word/${id}.xml`, `<w:${kind === 'header' ? 'hdr' : 'ftr'} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${id}</w:t></w:r></w:p></w:${kind === 'header' ? 'hdr' : 'ftr'}>`)
    archive.file('word/config/settings.xml', `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:evenAndOddHeaders${flag}/></w:settings>`)
    const result = await importDocxToHtml(await archive.generateAsync({ type: 'uint8array' }))
    expect(result.layout!.headerFooter).toMatchObject({ headerHtml: '<p>header-default</p>', footerHtml: '<p>footer-default</p>', differentFirstPage: value === '', pageNumberStart: 4 })
    expect(result.layout!.evenAndOddHeaders).toBe(value === '')
    expect(result.layout!.headerFooterVariants).toEqual(parts.flatMap(({ kind, variant, id }) => variant === 'default' ? [] : [{ kind, variant, html: `<p>${id}</p>` }]))
    expect(result.warnings).toEqual([])
  })

  it.each([
    ['letter', 'portrait', 12240, 15840], ['letter', 'landscape', 15840, 12240],
    ['a4', 'portrait', 11906, 16838], ['a4', 'landscape', 16838, 11906],
  ] as const)('detects %s paper in %s orientation from both native dimensions', async (paper, orientation, width, height) => {
    const fixture = resolve(import.meta.dir, '../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
    const archive = await JSZip.loadAsync(await Bun.file(fixture).arrayBuffer())
    archive.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="${width}" w:h="${height}" w:orient="${orientation}"/></w:sectPr></w:body></w:document>`)
    const result = await importDocxToHtml(await archive.generateAsync({ type: 'uint8array' }))
    expect(result.layout?.page).toMatchObject({ size: paper, orientation })
  })

  it('imports native header/footer relationships even when the main body is empty', async () => {
    const fixture = resolve(import.meta.dir, '../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
    const archive = await JSZip.loadAsync(await Bun.file(fixture).arrayBuffer())
    archive.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p/><w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:left="720"/></w:sectPr></w:body></w:document>')
    archive.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="header" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="footer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>')
    archive.file('word/header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Report header</w:t></w:r></w:p></w:hdr>')
    archive.file('word/footer1.xml', '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Report footer</w:t></w:r></w:p></w:ftr>')
    const result = await importDocxToHtml(await archive.generateAsync({ type: 'uint8array' }))
    expect(result.layout?.headerFooter.headerHtml).toContain('<strong>Report header</strong>')
    expect(result.layout?.headerFooter.footerHtml).toContain('Report footer')
    expect(result.layout?.page).toEqual({ size: 'letter', orientation: 'portrait', margins: 'narrow' })
    expect(result.sourceProtected).toBe(true)
  })
  it('converts DOCX OOXML bytes into semantic HTML', async () => {
    const fixture = resolve(import.meta.dir, '../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
    const bytes = new Uint8Array(await Bun.file(fixture).arrayBuffer())

    const result = await importDocxToHtml(bytes)

    expect(result.html).toBe('<p>Walking on imported air</p>')
    expect(result.warnings).toEqual([])
  })

  it('rejects an empty file before invoking the converter', async () => {
    await expect(importDocxToHtml(new Uint8Array())).rejects.toThrow('empty')
  })
})
