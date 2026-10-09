import { describe, expect, it } from 'bun:test'
import {
  derivedPresentationSource,
  embeddedPresentationSource,
  isValidPresentationSource,
  mountedPresentationSource,
  presentationMountSource,
  presentationDerivedSource,
  presentationPptxSource,
} from '../sourceReference'

describe('PowerPoint source references', () => {
  it('round-trips mount identities and nested relative paths', () => {
    const source = presentationMountSource('mount one', 'folder/素材 01.png')
    expect(source).toBe('bridgic-mount:mount%20one/folder/%E7%B4%A0%E6%9D%90%2001.png')
    expect(mountedPresentationSource(source)).toEqual({ mountId: 'mount one', relativePath: 'folder/素材 01.png' })
  })

  it('round-trips package-owned asset paths independently from mounts', () => {
    const source = presentationPptxSource('project one', 'ppt/media/素材 01.png')
    expect(source).toBe('bridgic-pptx:project%20one/ppt/media/%E7%B4%A0%E6%9D%90%2001.png')
    expect(embeddedPresentationSource(source)).toEqual({ projectId: 'project one', partPath: 'ppt/media/素材 01.png' })
    expect(isValidPresentationSource(source)).toBe(true)
  })

  it('keeps importer-derived display assets in project data without a hidden file', () => {
    const dataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'
    const source = presentationDerivedSource(dataUrl)
    expect(source).toStartWith('bridgic-pptx-derived:')
    expect(derivedPresentationSource(source)).toBe(dataUrl)
    expect(isValidPresentationSource(source)).toBe(true)
  })

  it('rejects traversal and malformed encoded segments', () => {
    expect(() => presentationMountSource('mount', '../secret.png')).toThrow('Invalid mount-relative path')
    expect(() => presentationMountSource('mount/root')).toThrow('valid mount id')
    expect(mountedPresentationSource('bridgic-mount:mount/%2E%2E/secret.png')).toBeUndefined()
    expect(mountedPresentationSource('bridgic-mount:mount/%E0%A4%A')).toBeUndefined()
    expect(embeddedPresentationSource('bridgic-pptx:project/%2E%2E/secret.png')).toBeUndefined()
    expect(isValidPresentationSource('bridgic-asset:orphan')).toBe(false)
  })
})
