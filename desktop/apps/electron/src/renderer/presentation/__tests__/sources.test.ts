import { expect, it } from 'bun:test'
import type { PresentationSourceMount } from '@shared/presentation-host'
import { createBlankPresentationProject } from '@/atoms/presentation'
import JSZip from 'jszip'
import { presentationMountSource, presentationPptxSource } from '../sourceReference'
import { presentationPptxSourceUrls, presentationSourceUrls, rebasePresentationPptxSources } from '../sources'

it('resolves mounted sources without treating package-owned assets as Files mounts', async () => {
  const hadWindow = 'window' in globalThis
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { ...previousWindow, __localResourceToken__: 'source-test-token' },
    writable: true,
  })
  try {
    const inserted: PresentationSourceMount = {
      id: 'inserted', name: 'photo.png', path: '/external/photo.png', kind: 'file', exists: true,
      size_bytes: 3, item_count: null, removable: true, created_at: new Date(0).toISOString(),
    }
    const external = presentationMountSource(inserted.id)
    const urls = presentationSourceUrls([external], [inserted])

    expect(new URL(urls[external]!).searchParams.get('src')).toBe('file:///external/photo.png')
  } finally {
    if (hadWindow) Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow, writable: true })
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

it('resolves embedded sources from the original PPTX package', async () => {
  const project = createBlankPresentationProject('Imported')
  const source = presentationPptxSource(project.id, 'ppt/media/image1.png')
  project.assets = [{ id: 'asset-1', kind: 'image', mimeType: 'image/png', name: 'image1.png', source }]
  const archive = new JSZip()
  archive.file('ppt/media/image1.png', 'png')
  const encoded = await archive.generateAsync({ type: 'base64' })

  expect(await presentationPptxSourceUrls(project, encoded)).toEqual({
    [source]: 'data:image/png;base64,cG5n',
  })
})

it('rebases exported media to the output PPTX while leaving its Files mount untouched', async () => {
  const project = createBlankPresentationProject('Exported')
  project.assets = [{ id: 'asset-1', kind: 'image', mimeType: 'image/png', name: 'inserted.png', source: 'bridgic-mount:inserted' }]
  const materialized = { ...project, assets: [{ ...project.assets[0]!, source: 'data:image/png;base64,cG5n' }] }
  const archive = new JSZip()
  archive.file('ppt/media/image1.png', 'png')
  const encoded = await archive.generateAsync({ type: 'base64' })

  const rebased = await rebasePresentationPptxSources(project, materialized, encoded)

  expect(rebased.project.assets[0]!.source).toBe(presentationPptxSource(project.id, 'ppt/media/image1.png'))
  expect(rebased.replacements.get('bridgic-mount:inserted')).toBe(presentationPptxSource(project.id, 'ppt/media/image1.png'))
})

it('resolves and rebases the embedded layer used by an Office picture effect', async () => {
  const project = createBlankPresentationProject('Effect')
  const imageSource = presentationPptxSource(project.id, 'ppt/media/original.png')
  const layerSource = presentationPptxSource(project.id, 'ppt/media/original.wdp')
  project.assets = [{ id: 'effect-image', kind: 'image', mimeType: 'image/png', name: 'original.png', source: imageSource,
    imageEffects: { officeLayer: { source: layerSource, effects: [{ type: 'backgroundRemoval',
      bounds: { top: 0, bottom: 100000, left: 0, right: 100000 }, foregroundMarks: [], backgroundMarks: [] }] } } }]
  const original = new JSZip()
  original.file('ppt/media/original.png', 'png')
  original.file('ppt/media/original.wdp', 'wdp')
  const urls = await presentationPptxSourceUrls(project, await original.generateAsync({ type: 'base64' }))
  expect(urls[imageSource]).toBe('data:image/png;base64,cG5n')
  expect(urls[layerSource]).toBe('data:image/vnd.ms-photo;base64,d2Rw')

  const materialized = { ...project, assets: [{ ...project.assets[0]!, source: urls[imageSource]!,
    imageEffects: { officeLayer: { ...project.assets[0]!.imageEffects!.officeLayer!, source: urls[layerSource]! } } }] }
  const output = new JSZip()
  output.file('ppt/media/new.png', 'png')
  output.file('ppt/media/new.wdp', 'wdp')
  const rebased = await rebasePresentationPptxSources(project, materialized, await output.generateAsync({ type: 'base64' }))
  expect(rebased.project.assets[0]!.source).toBe(presentationPptxSource(project.id, 'ppt/media/new.png'))
  expect(rebased.project.assets[0]!.imageEffects?.officeLayer?.source).toBe(presentationPptxSource(project.id, 'ppt/media/new.wdp'))
})
