import { describe, expect, it } from 'bun:test'
import { DOMParser } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { PRESENTATION_PAGE_SIZES, type PresentationProject, type PresentationFileSource } from '@/atoms/presentation'
import { createPresentationTestDocument as createInitialPresentationProject } from '@/test-fixtures/presentation'
import { createPresentationPptx } from '../presentationPptx'
import { normalizePresentationProject, presentationElementSource } from '@/presentation/project'
import { validatePresentationProject } from '@/presentation/model/reducer'
import { materializePresentationProjectSources, presentationPptxSourceUrls } from '@/presentation/sources'

function addImageAsset(document: PresentationProject, id: string, source: PresentationFileSource): void {
  document.assets.push({ id, kind: 'image', mimeType: source.mimeType, name: source.fileName, source: source.dataUrl })
}

describe('importPresentationPptx', () => {
  it('preserves the editable master and footer through repeated save and reopen cycles', async () => {
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const source = normalizePresentationProject(createInitialPresentationProject())
    source.theme.footer = { text: 'Confidential', showDate: true, showSlideNumber: true }
    source.theme.bodyFontFamily = 'Arial'
    source.theme.titleFontFamily = 'Georgia'
    let document = source
    for (let cycle = 0; cycle < 2; cycle++) {
      document = await importPresentationPptx(await createPresentationPptx(document), 'Report.pptx', { restoreEditorModel: true })
      expect(document.theme).toEqual(source.theme)
      expect(document.slides.pages).toEqual(source.slides.pages)
      expect(document).not.toHaveProperty('sourceProtected')
      document.slides.pages[0]!.notes = `Edited note ${cycle}`
      source.slides.pages[0]!.notes = `Edited note ${cycle}`
    }
  })

  it('invalidates its embedded model after an external edit without adding host metadata', async () => {
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const source = createInitialPresentationProject()
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slide = archive.file('ppt/slides/slide1.xml')!
    archive.file(slide.name, (await slide.async('string')).replace(/<a:t>[^<]*<\/a:t>/, '<a:t>Externally corrected</a:t>'))
    const imported = await importPresentationPptx(await archive.generateAsync({ type: 'uint8array' }), 'Report.pptx', { restoreEditorModel: true })
    expect(JSON.stringify(imported.slides.pages)).toContain('Externally corrected')
    expect(imported).not.toHaveProperty('sourceProtected')
  })

  it('falls back to native PPTX content when a matching embedded model is invalid', async () => {
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const source = createInitialPresentationProject()
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const modelFile = archive.file('bridgic/editor-model.json')!
    const envelope = JSON.parse(await modelFile.async('string')) as Record<string, unknown>
    archive.file(modelFile.name, JSON.stringify({ ...envelope, document: { schemaVersion: 1, version: 1 } }))
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      const imported = await importPresentationPptx(
        await archive.generateAsync({ type: 'uint8array' }),
        'Recovered.pptx',
        { restoreEditorModel: true },
      )
      expect(imported.slides.pages.length).toBeGreaterThan(0)
      expect(JSON.stringify(imported.slides.pages)).toContain('Primary message')
      expect(imported).not.toHaveProperty('sourceProtected')
      expect(warnings[0]?.[0]).toContain('Ignoring an invalid embedded editor model')
    } finally {
      console.warn = originalWarn
    }
  })

  it('shares a master image across slides and preserves sharing through worker transfer', async () => {
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const source = createInitialPresentationProject()
    const second = structuredClone(source.slides.pages[0]!)
    second.id = 'second-slide'
    source.slides.pages = [source.slides.pages[0]!, second]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    for (const file of Object.values(archive.files)) {
      if (/^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(file.name)) {
        archive.file(file.name, (await file.async('text')).replace(/<p:bg>.*?<\/p:bg>/s, ''))
      }
    }
    const master = archive.file('ppt/slideMasters/slideMaster1.xml')!
    archive.file(master.name, (await master.async('text')).replace(/(<p:cSld[^>]*>)/, '$1<p:bg><p:bgPr><a:blipFill><a:blip r:embed="sharedBackground"/></a:blipFill></p:bgPr></p:bg>'))
    const rels = archive.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')!
    archive.file(rels.name, (await rels.async('text')).replace('</Relationships>', '<Relationship Id="sharedBackground" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/shared.png"/></Relationships>'))
    archive.file('ppt/media/shared.png', new Uint8Array([137, 80, 78, 71]))
    const bytes = await archive.generateAsync({ type: 'uint8array' })
    const imported = structuredClone(await importPresentationPptx(bytes))
    const sources = await presentationPptxSourceUrls(imported, Buffer.from(bytes).toString('base64'))
    const images = imported.slides.pages.map((slide) => slide.elements[0]!)
    expect(images).toHaveLength(2)
    expect(images.every((element) => element.type === 'image')).toBe(true)
    if (images[0]!.type !== 'image' || images[1]!.type !== 'image') throw new Error('Missing background')
    expect(images[0]!.sourceAssetId).toBe(images[1]!.sourceAssetId)
    expect(presentationElementSource(imported, images[0]!, sources)!.dataUrl).toBe('data:image/png;base64,iVBORw==')
    expect(images[0]!.id).not.toBe(images[1]!.id)
  })

  it('preserves slide, layout and master background images behind foreground elements', async () => {
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const bytes = await createPresentationPptx(createInitialPresentationProject())
    const owners = ['slides/slide1.xml', 'slideLayouts/slideLayout1.xml', 'slideMasters/slideMaster1.xml']
    for (const owner of owners) {
      const archive = await JSZip.loadAsync(bytes)
      for (const part of owners) {
        const file = archive.file(`ppt/${part}`)!
        archive.file(file.name, (await file.async('text')).replace(/<p:bg>.*?<\/p:bg>/s, ''))
      }
      const file = archive.file(`ppt/${owner}`)!
      const background = '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="templateBackground"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg>'
      archive.file(file.name, (await file.async('text')).replace(/(<p:cSld[^>]*>)/, `$1${background}`))
      const [folder, name] = owner.split('/')
      const rels = archive.file(`ppt/${folder}/_rels/${name}.rels`)!
      archive.file(rels.name, (await rels.async('text')).replace('</Relationships>',
        '<Relationship Id="templateBackground" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/template-background.png"/></Relationships>'))
      archive.file('ppt/media/template-background.png', new Uint8Array([137, 80, 78, 71]))
      const modifiedBytes = await archive.generateAsync({ type: 'uint8array' })
      const imported = await importPresentationPptx(modifiedBytes)
      const sources = await presentationPptxSourceUrls(imported, Buffer.from(modifiedBytes).toString('base64'))
      const first = imported.slides.pages[0]!.elements[0]!
      expect(first.type).toBe('image')
      if (first.type !== 'image') throw new Error('Background missing')
      expect(presentationElementSource(imported, first, sources)!.fileName).toBe('template-background.png')
      expect([first.x, first.y, first.width, first.height]).toEqual([0, 0, imported.pageSize.width, imported.pageSize.height])
      expect(imported.slides.pages[0]!.elements.slice(1).some(element => element.type === 'text')).toBe(true)
    }
  })

  it('round-trips editable slides, geometry, notes and page size', async () => {
    const source = createInitialPresentationProject()
    source.theme.accentColors = ['#123456', '#ABCDEF', '#CC5500', '#118844', '#663399', '#DDCC22']
    source.theme.background = '#112233'
    source.theme.bodyFontFamily = 'Arial'
    source.theme.titleFontFamily = 'Georgia'
    source.pageSize = PRESENTATION_PAGE_SIZES.standard
    source.slides.pages[0]!.notes = 'Presenter note'
    const animated = source.slides.pages[0]!.elements.find((element) => element.type === 'text')!
    animated.animation = 'split'
    if (animated.type === 'text') animated.characterSpacing = 125
    const bytes = await createPresentationPptx(source)
    const { importPresentationPptx } = await import('../presentationPptxImport')

    const imported = await importPresentationPptx(bytes, 'round-trip.pptx')

    expect(imported.title).toBe('round-trip')
    expect(imported.pageSize).toEqual(PRESENTATION_PAGE_SIZES.standard)
    expect(imported.theme.accentColors).toEqual(source.theme.accentColors)
    expect(imported.theme).toMatchObject({ background: '#112233', bodyFontFamily: 'Arial', titleFontFamily: 'Georgia' })
    expect(imported.slides.pages[0]!.background).toBeUndefined()
    expect(imported.slides.pages[1]!.background).toBe('#F7F6F2')
    expect(imported.slides.pages).toHaveLength(source.slides.pages.length)
    expect(imported.slides.pages[0]!.notes).toContain('Presenter note')
    expect(imported.slides.pages[0]!.elements.some((element) => element.type === 'text')).toBe(true)
    const importedText = imported.slides.pages[0]!.elements.find((element) => element.type === 'text')
    expect(importedText?.animation).toBe('split')
    expect(importedText?.type).toBe('text')
    if (importedText?.type === 'text') expect(importedText.characterSpacing).toBeCloseTo(125, 1)
    expect(imported.slides.pages[0]!.elements.some((element) => element.type !== 'text')).toBe(true)
  })

  it('imports only the requested source slides for lightweight template previews', async () => {
    const source = createInitialPresentationProject()
    const first = source.slides.pages[0]!
    const second = structuredClone(first)
    second.id = 'preview-slide-2'
    second.name = 'Second source slide'
    const third = structuredClone(first)
    third.id = 'preview-slide-3'
    third.name = 'Third source slide'
    source.slides.pages = [first, second, third]
    source.slides.selectedPageId = first.id
    const bytes = await createPresentationPptx(source)
    const { importPresentationPptx } = await import('../presentationPptxImport')

    const imported = await importPresentationPptx(bytes, 'preview.pptx', {
      slideNumbers: [1, 3, 3, 99],
    })

    expect(imported.slides.pages).toHaveLength(2)
    expect(imported.slides.pages.map(slide => slide.name)).toEqual(['Slide 1', 'Slide 3'])
  })

  it('cleans omitted page links and assets when restoring a page subset', async () => {
    const source = createInitialPresentationProject()
    const [first, second] = source.slides.pages
    const firstText = first!.elements.find((element) => element.type === 'text')!
    firstText.hyperlink = { type: 'slide', slideId: second!.id }
    addImageAsset(source, 'retained-asset', {
      dataUrl: 'data:image/png;base64,YQ==', fileName: 'retained.png', mimeType: 'image/png',
    })
    addImageAsset(source, 'omitted-asset', {
      dataUrl: 'data:image/png;base64,Yg==', fileName: 'omitted.png', mimeType: 'image/png',
    })
    first!.elements.push({
      id: 'retained-image', type: 'image', sourceAssetId: 'retained-asset', altText: '', fit: 'contain',
      x: 10, y: 10, width: 20, height: 20, rotation: 0,
    })
    second!.elements.push({
      id: 'omitted-image', type: 'image', sourceAssetId: 'omitted-asset', altText: '', fit: 'contain',
      x: 10, y: 10, width: 20, height: 20, rotation: 0,
    })
    const bytes = await createPresentationPptx(source)
    const { importPresentationPptx } = await import('../presentationPptxImport')

    const imported = await importPresentationPptx(bytes, 'subset.pptx', {
      restoreEditorModel: true,
      slideNumbers: [1],
    })

    expect(imported.slides.pages).toHaveLength(1)
    expect(imported.slides.pages[0]!.elements.find((element) => element.id === firstText.id)).not.toHaveProperty('hyperlink')
    expect(imported.assets.map((asset) => asset.id)).toEqual(['retained-asset'])
    expect(validatePresentationProject(imported)).toBe(imported)
  })

  it('preserves mixed shape-picture z-order, source crop and text-box layout', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    addImageAsset(source, 'middle-picture-asset', {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9N8AAAAASUVORK5CYII=',
      fileName: 'pixel.png',
      mimeType: 'image/png',
    })
    slide.elements = [
      {
        id: 'background-shape',
        type: 'rect',
        x: 0,
        y: 0,
        width: 640,
        height: 360,
        rotation: 0,
        fill: '#F7F4EC',
        borderColor: 'transparent',
        borderWidth: 0,
      },
      {
        id: 'middle-picture',
        type: 'image',
        sourceAssetId: 'middle-picture-asset',
        x: 80,
        y: 40,
        width: 320,
        height: 200,
        rotation: 0,
        altText: 'cropped picture',
        fit: 'cover',
        crop: { left: 0.1, top: 0.2, right: 0.15, bottom: 0.05 },
      },
      {
        id: 'foreground-text',
        type: 'text',
        x: 120,
        y: 80,
        width: 180,
        height: 80,
        rotation: 0,
        text: 'Do not wrap this title',
        fontSize: 28,
        fontFamily: 'Aptos',
        fontWeight: 700,
        color: '#20202B',
        align: 'left',
        wordWrap: false,
        textInsets: { left: 4, top: 6, right: 8, bottom: 10 },
      },
    ]
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await createPresentationPptx(source), 'layered.pptx')
    const elements = imported.slides.pages[0]!.elements

    expect(elements.map((element) => element.type)).toEqual(['rect', 'image', 'text'])
    const image = elements[1]
    const text = elements[2]
    expect(image?.type).toBe('image')
    if (image?.type === 'image') {
      expect(image.crop?.left).toBeCloseTo(0.1, 3)
      expect(image.crop?.top).toBeCloseTo(0.2, 3)
      expect(image.crop?.right).toBeCloseTo(0.15, 3)
      expect(image.crop?.bottom).toBeCloseTo(0.05, 3)
    }
    expect(text?.type).toBe('text')
    if (text?.type === 'text') {
      expect(text.wordWrap).toBe(false)
      expect(text.textInsets?.left).toBeCloseTo(4, 1)
      expect(text.textInsets?.top).toBeCloseTo(6, 1)
    }
  })

  it('keeps color-keyed pictures visible and preserves picture mirroring', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    addImageAsset(source, 'color-keyed-picture-asset', {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9N8AAAAASUVORK5CYII=',
      fileName: 'plum.png',
      mimeType: 'image/png',
    })
    slide.elements = [{
      id: 'color-keyed-picture',
      type: 'image',
      sourceAssetId: 'color-keyed-picture-asset',
      x: 80,
      y: 40,
      width: 320,
      height: 200,
      rotation: 0,
      altText: 'plum blossom',
      fit: 'contain',
    }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const slideXml = await slideFile.async('text')
    const withColorKey = slideXml
      .replace(
        /<a:blip (r:embed="rId\d+")>/,
        '<a:blip $1><a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom><a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>',
      )
      .replace(/(<p:pic>[\s\S]*?<a:xfrm)(>)/, '$1 flipH="1" flipV="1"$2')
    expect(withColorKey).not.toBe(slideXml)
    archive.file('ppt/slides/slide1.xml', withColorKey)
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await archive.generateAsync({ type: 'uint8array' }), 'color-key.pptx')
    const image = imported.slides.pages[0]!.elements.find((element) => element.type === 'image')

    expect(image?.type).toBe('image')
    if (image?.type === 'image') {
      expect(image.opacity).toBeUndefined()
      expect(image.flipHorizontal).toBe(true)
      expect(image.flipVertical).toBe(true)
    }
  })

  it('keeps an imported picture stretched to its non-square frame', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    addImageAsset(source, 'square-picture', {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9N8AAAAASUVORK5CYII=',
      fileName: 'square.png', mimeType: 'image/png',
    })
    slide.elements = [{
      id: 'stretched-picture', type: 'image', sourceAssetId: 'square-picture',
      x: 20, y: 30, width: 200, height: 100, rotation: 0, altText: '', fit: 'stretch',
    }]
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const bytes = await createPresentationPptx(source)
    const imported = await importPresentationPptx(bytes, 'stretched.pptx')
    expect(imported.slides.pages[0]!.elements.find(element => element.type === 'image')).toMatchObject({
      type: 'image', fit: 'stretch', width: 200, height: 100,
    })
    const urls = await presentationPptxSourceUrls(imported, Buffer.from(bytes).toString('base64'))
    const reopened = await importPresentationPptx(
      await createPresentationPptx(await materializePresentationProjectSources(imported, urls)),
      'stretched-round-trip.pptx',
    )
    expect(reopened.slides.pages[0]!.elements.find(element => element.type === 'image')).toMatchObject({ type: 'image', fit: 'stretch' })
  })

  it('imports an ellipse shape with a picture fill as a clipped image instead of its theme fallback color', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    addImageAsset(source, 'landscape-picture-asset', {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9N8AAAAASUVORK5CYII=',
      fileName: 'landscape.png',
      mimeType: 'image/png',
    })
    slide.elements = [{
      id: 'landscape-picture',
      type: 'image',
      sourceAssetId: 'landscape-picture-asset',
      x: 141,
      y: 261,
      width: 221,
      height: 221,
      rotation: 0,
      altText: 'landscape',
      fit: 'cover',
    }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const slideXml = await slideFile.async('text')
    const picture = slideXml.match(/<p:pic>[\s\S]*?<\/p:pic>/)?.[0]
    const relationshipId = picture?.match(/<a:blip r:embed="(rId\d+)"/)?.[1]
    const transform = picture?.match(/<a:xfrm[\s\S]*?<\/a:xfrm>/)?.[0]
    expect(picture).toBeTruthy()
    expect(relationshipId).toBeTruthy()
    expect(transform).toBeTruthy()
    const pictureFilledEllipse = `<p:sp><p:nvSpPr><p:cNvPr id="42" name="Picture-filled ellipse" descr="landscape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:ln><a:noFill/></a:ln></p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
    archive.file('ppt/slides/slide1.xml', slideXml.replace(picture!, pictureFilledEllipse))
    const { importPresentationPptx } = await import('../presentationPptxImport')

    const bytes = await archive.generateAsync({ type: 'uint8array' })
    const imported = await importPresentationPptx(bytes, 'picture-filled-shape.pptx')
    const sources = await presentationPptxSourceUrls(imported, Buffer.from(bytes).toString('base64'))
    const image = imported.slides.pages[0]!.elements[0]

    expect(image?.type).toBe('image')
    if (image?.type === 'image') {
      expect(image.clipShape).toBe('ellipse')
      expect(presentationElementSource(imported, image, sources)!.mimeType).toBe('image/png')
      expect(presentationElementSource(imported, image, sources)!.dataUrl).toStartWith('data:image/png;base64,')
      expect(image.altText).toBe('landscape')
    }

    const reimported = await importPresentationPptx(
      await createPresentationPptx(await materializePresentationProjectSources(imported, sources)),
      'picture-filled-shape-round-trip.pptx',
    )
    expect(reimported.slides.pages[0]!.elements[0]).toMatchObject({ type: 'image', clipShape: 'ellipse' })
  })

  it('keeps imported picture effects and their embedded Office layer through export', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    addImageAsset(source, 'picture-asset', {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9N8AAAAASUVORK5CYII=',
      fileName: 'picture.png', mimeType: 'image/png',
    })
    slide.elements = [{ id: 'picture', type: 'image', sourceAssetId: 'picture-asset',
      x: 30, y: 40, width: 200, height: 150, rotation: 0, altText: '', fit: 'contain' }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const effect = '<a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom><a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>'
      + '<a:extLst><a:ext uri="{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}"><a14:imgProps xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><a14:imgLayer r:embed="rId77"><a14:imgEffect><a14:backgroundRemoval t="10" b="90000" l="20" r="80000"><a14:foregroundMark x1="1" y1="2" x2="3" y2="4"/><a14:backgroundMark x1="5" y1="6" x2="7" y2="8"/></a14:backgroundRemoval></a14:imgEffect></a14:imgLayer></a14:imgProps></a:ext></a:extLst>'
    archive.file(slideFile.name, (await slideFile.async('text')).replace(/<a:blip (r:embed="[^"]+")><\/a:blip>/, `<a:blip $1>${effect}</a:blip>`))
    const relationships = archive.file('ppt/slides/_rels/slide1.xml.rels')!
    archive.file(relationships.name, (await relationships.async('text')).replace('</Relationships>',
      '<Relationship Id="rId77" Type="http://schemas.microsoft.com/office/2007/relationships/hdphoto" Target="../media/layer.wdp"/></Relationships>'))
    archive.file('ppt/media/layer.wdp', new Uint8Array([0x49, 0x49, 0x42, 0x43]))
    const bytes = await archive.generateAsync({ type: 'uint8array' })
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(bytes, 'effects.pptx')
    const asset = imported.assets.find(value => value.imageEffects)!
    expect(asset).toBeDefined()
    expect(asset.imageEffects).toMatchObject({
      colorChange: { from: '#FFFFFF', to: '#FFFFFF', opacity: 0 },
      backgroundRemoval: { bounds: { top: 10, bottom: 90000, left: 20, right: 80000 },
        foregroundMarks: [{ x1: 1, y1: 2, x2: 3, y2: 4 }], backgroundMarks: [{ x1: 5, y1: 6, x2: 7, y2: 8 }] },
    })
    expect(asset.imageEffects?.backgroundRemoval?.layerSource).toStartWith(`bridgic-pptx:${imported.id}/`)
    const urls = await presentationPptxSourceUrls(imported, Buffer.from(bytes).toString('base64'))
    const exported = await createPresentationPptx(await materializePresentationProjectSources(imported, urls))
    const output = await JSZip.loadAsync(exported)
    const outputXml = await output.file('ppt/slides/slide1.xml')!.async('text')
    expect(outputXml).toContain('<a:clrChange>')
    expect(outputXml).toContain('<a14:backgroundRemoval')
    expect(outputXml).toContain('<a14:foregroundMark x1="1" y1="2" x2="3" y2="4"/>')
    expect(Object.keys(output.files).some(path => path.endsWith('.wdp'))).toBe(true)
    const reopened = await importPresentationPptx(exported, 'effects-export.pptx')
    expect(reopened.assets.some(value => value.imageEffects?.backgroundRemoval)).toBe(true)
  })

  it('imports East Asian vertical text and DrawingML preset colors', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    slide.elements = [{
      id: 'vertical-copy',
      type: 'text',
      x: 80,
      y: 80,
      width: 120,
      height: 320,
      rotation: 0,
      text: '请输入文本内容\n请输入文本内容',
      fontSize: 28,
      fontFamily: 'Aptos',
      fontWeight: 400,
      color: '#20202B',
      align: 'left',
      wordWrap: true,
    }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const slideXml = await slideFile.async('text')
    const withVerticalWhiteText = slideXml
      .replace('<a:bodyPr', '<a:bodyPr vert="eaVert"')
      .replace(/\s(?:lIns|tIns|rIns|bIns)="[^"]*"/g, '')
      .replace(/<a:srgbClr val="20202B"\/>/, '<a:prstClr val="white"/>')
    expect(withVerticalWhiteText).not.toBe(slideXml)
    archive.file('ppt/slides/slide1.xml', withVerticalWhiteText)
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await archive.generateAsync({ type: 'uint8array' }), 'vertical.pptx')
    const text = imported.slides.pages[0]!.elements.find((element) => element.type === 'text')

    expect(text?.type).toBe('text')
    if (text?.type === 'text') {
      expect(text.textDirection).toBe('eastAsianVertical')
      expect(text.color).toBe('#FFFFFF')
      expect(text.textInsets).toEqual({ left: 9.6, top: 4.8, right: 9.6, bottom: 4.8 })
    }
  })

  it('prefers the East Asian run font for CJK text', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    slide.elements = [{
      id: 'cjk-text',
      type: 'text',
      x: 80,
      y: 80,
      width: 360,
      height: 100,
      rotation: 0,
      text: '佛教历史',
      fontSize: 28,
      fontFamily: 'Aptos',
      fontWeight: 400,
      color: '#20202B',
      align: 'left',
      wordWrap: true,
    }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const slideXml = await slideFile.async('text')
    const withEastAsianFont = slideXml.replace(
      /<a:latin\b[^>]*\/>/,
      '<a:latin typeface="Latin Font"/><a:ea typeface="East Asian Font"/>',
    )
    expect(withEastAsianFont).not.toBe(slideXml)
    archive.file('ppt/slides/slide1.xml', withEastAsianFont)
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await archive.generateAsync({ type: 'uint8array' }), 'cjk-font.pptx')
    const text = imported.slides.pages[0]!.elements.find((element) => element.type === 'text')

    expect(text?.type).toBe('text')
    if (text?.type === 'text') expect(text.fontFamily).toBe('East Asian Font')
  })

  it('keeps custom geometry as a native editable shape through import and export', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    slide.elements = [{
      id: 'accent',
      type: 'rect',
      x: 40,
      y: 40,
      width: 300,
      height: 180,
      rotation: 0,
      fill: '#A8351A',
      borderColor: 'transparent',
      borderWidth: 0,
    }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const slideXml = await slideFile.async('text')
    const customGeometry = '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:lnTo><a:pt x="100" y="8"/></a:lnTo><a:lnTo><a:pt x="0" y="8"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>'
    archive.file('ppt/slides/slide1.xml', slideXml.replace(/<a:prstGeom prst="rect">.*?<\/a:prstGeom>/, customGeometry))
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await archive.generateAsync({ type: 'uint8array' }), 'custom-shape.pptx')
    const customShape = imported.slides.pages[0]!.elements[0]

    expect(customShape?.type).toBe('rect')
    if (customShape?.type !== 'rect') throw new Error('Missing custom shape')
    expect(customShape.customGeometry).toEqual({
      paths: [{
        width: 100,
        height: 100,
        fill: 'normal',
        stroke: true,
        commands: [
          { type: 'moveTo', x: 0, y: 0 },
          { type: 'lineTo', x: 100, y: 0 },
          { type: 'lineTo', x: 100, y: 8 },
          { type: 'lineTo', x: 0, y: 8 },
          { type: 'close' },
        ],
      }],
    })
    expect(imported.assets).toHaveLength(0)

    const exported = await JSZip.loadAsync(await createPresentationPptx(imported))
    const exportedSlide = new DOMParser().parseFromString(await exported.file('ppt/slides/slide1.xml')!.async('text'), 'text/xml')
    const exportedShape = Array.from(exportedSlide.getElementsByTagName('p:sp'))
      .find(shape => shape.getElementsByTagName('p:cNvPr')[0]?.getAttribute('name') === customShape.id)
    expect(exportedShape?.getElementsByTagName('a:custGeom')).toHaveLength(1)
    expect(Array.from(exportedShape!.getElementsByTagName('a:pt')).map(point => [point.getAttribute('x'), point.getAttribute('y')])).toEqual([
      ['0', '0'], ['100', '0'], ['100', '8'], ['0', '8'],
    ])
  })

  it('imports an Office SVG extension when the picture has no raster fallback relationship', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    addImageAsset(source, 'svg-picture-asset', {
      dataUrl: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#A8351A"/></svg>')}`,
      fileName: 'circles.svg',
      mimeType: 'image/svg+xml',
    })
    slide.elements = [{
      id: 'svg-picture',
      type: 'image',
      sourceAssetId: 'svg-picture-asset',
      x: 420,
      y: 180,
      width: 320,
      height: 320,
      rotation: 0,
      opacity: 0.1,
      altText: 'concentric circles',
      fit: 'contain',
    }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const slideXml = await slideFile.async('text')
    const extensionOnly = slideXml.replace(/<a:blip r:embed="rId\d+">/, '<a:blip>')
    expect(extensionOnly).not.toBe(slideXml)
    expect(extensionOnly).toContain('svgBlip')
    archive.file('ppt/slides/slide1.xml', extensionOnly)
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const bytes = await archive.generateAsync({ type: 'uint8array' })
    const imported = await importPresentationPptx(bytes, 'svg-extension.pptx')
    const sources = await presentationPptxSourceUrls(imported, Buffer.from(bytes).toString('base64'))
    const image = imported.slides.pages[0]!.elements.find((element) => element.type === 'image')

    expect(image?.type).toBe('image')
    if (image?.type === 'image') {
      expect(presentationElementSource(imported, image, sources)!.mimeType).toBe('image/svg+xml')
      expect(image.opacity).toBeCloseTo(0.1, 4)
    }
  })

  it('imports common editable tables and charts', async () => {
    const source = createInitialPresentationProject()
    const slide = source.slides.pages[0]!
    source.slides.pages = [slide]
    source.slides.selectedPageId = slide.id
    slide.elements = [
      {
        id: 'table',
        type: 'table',
        x: 40,
        y: 60,
        width: 420,
        height: 240,
        rotation: 0,
        cells: [['Period', 'Users'], ['Q1', '12'], ['Q2', '18']],
        headerRow: true,
        headerFill: '#EAE6FF',
        bodyFill: '#FFFFFF',
        textColor: '#20202B',
        borderColor: '#D9D7E2',
        fontSize: 15,
      },
      {
        id: 'chart',
        type: 'chart',
        x: 500,
        y: 60,
        width: 560,
        height: 320,
        rotation: 0,
        chartType: 'column',
        categories: ['Q1', 'Q2'],
        series: [{ name: 'Users', values: [12, 18] }],
        showLegend: true,
        showValue: true,
        title: 'Quarterly users',
        colors: ['#6957D9'],
        chartAreaFill: 'transparent',
        plotAreaFill: '#111727',
        categoryAxisLabelColor: '#C6CCE0',
        valueAxisLabelColor: '#7F89A8',
        gridLineColor: '#28314A',
        dataLabelColor: '#F5F7FF',
      },
    ]
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await createPresentationPptx(source), 'data.pptx')
    const table = imported.slides.pages[0]!.elements.find((element) => element.type === 'table')
    const chart = imported.slides.pages[0]!.elements.find((element) => element.type === 'chart')

    expect(table?.type).toBe('table')
    if (table?.type === 'table') expect(table.cells).toEqual([['Period', 'Users'], ['Q1', '12'], ['Q2', '18']])
    expect(chart?.type).toBe('chart')
    if (chart?.type === 'chart') {
      expect(chart.chartType).toBe('column')
      expect(chart.categories).toEqual(['Q1', 'Q2'])
      expect(chart.series[0]?.values).toEqual([12, 18])
      expect(chart.showValue).toBe(true)
      expect(chart.chartAreaFill).toBe('transparent')
      expect(chart.plotAreaFill).toBe('#111727')
      expect(chart.categoryAxisLabelColor).toBe('#C6CCE0')
      expect(chart.valueAxisLabelColor).toBe('#7F89A8')
      expect(chart.gridLineColor).toBe('#28314A')
      expect(chart.dataLabelColor).toBe('#F5F7FF')
    }
  })
})
