import { describe, expect, it } from 'bun:test'
import { createBlankPresentationProject } from '@/atoms/presentation'
import { presentationPptxSource } from '../sourceReference'
import { createPresentationAsset } from '../project'
import { migratePresentationWorkspace } from '../workspace'

describe('PresentationWorkspace', () => {
  it('keeps editable project content separate from Store and source metadata', () => {
    const project = createBlankPresentationProject('Pure project')
    const workspace = migratePresentationWorkspace({
      schemaVersion: 1,
      activeProjectId: project.id,
      projects: [project],
      projectMetadata: {
        [project.id]: {
          revision: 8,
          savedRevision: 7,
          source: { path: '/Pure project.pptx', mtimeMs: 42 },
          sourceProtected: true,
        },
      },
    })

    expect(workspace.projects[0]).toEqual(project)
    expect(workspace.projects[0]).not.toHaveProperty('revision')
    expect(workspace.projects[0]).not.toHaveProperty('source')
    expect(workspace.projects[0]).not.toHaveProperty('savedRevision')
    expect(workspace.projects[0]).not.toHaveProperty('sourceProtected')
    expect(workspace.projectMetadata[project.id]).toEqual({
      revision: 8,
      savedRevision: 7,
      source: { path: '/Pure project.pptx', mtimeMs: 42 },
      sourceProtected: true,
    })
  })

  it('migrates the former document envelope without retaining it as a runtime model', () => {
    const project = createBlankPresentationProject('Legacy project')
    const workspace = migratePresentationWorkspace({
      activeDocumentId: project.id,
      documents: [{
        ...project,
        revision: 5,
        savedRevision: 4,
        source: { path: '/Legacy project.pptx', mtimeMs: 10 },
      }],
    })

    expect(workspace).toMatchObject({
      schemaVersion: 1,
      activeProjectId: project.id,
      projects: [{ id: project.id, title: 'Legacy project' }],
      projectMetadata: { [project.id]: { revision: 5, savedRevision: 4, sourceProtected: true } },
    })
    expect(workspace.projects[0]).not.toHaveProperty('revision')
    expect(workspace.projects[0]).not.toHaveProperty('source')
  })

  it('persists mounted and PPTX source references but rejects embedded asset payloads', () => {
    const project = createBlankPresentationProject('Mounted project')
    project.assets = [createPresentationAsset('image', {
      dataUrl: 'bridgic-mount:source-image', fileName: 'source.png', mimeType: 'image/png',
    }, 'mounted-asset')]
    expect(migratePresentationWorkspace({
      schemaVersion: 1,
      activeProjectId: project.id,
      projects: [project],
      projectMetadata: { [project.id]: { revision: 1 } },
    }).projects[0]!.assets[0]!.source).toBe('bridgic-mount:source-image')

    project.assets[0]!.source = presentationPptxSource(project.id, 'ppt/media/source-image.png')
    expect(migratePresentationWorkspace({
      schemaVersion: 1,
      activeProjectId: project.id,
      projects: [project],
      projectMetadata: { [project.id]: { revision: 1 } },
    }).projects[0]!.assets[0]!.source).toBe(presentationPptxSource(project.id, 'ppt/media/source-image.png'))

    project.assets[0]!.imageEffects = { backgroundRemoval: {
      layerSource: presentationPptxSource(project.id, 'ppt/media/source-layer.wdp'),
      bounds: { top: 0, bottom: 100000, left: 0, right: 100000 }, foregroundMarks: [], backgroundMarks: [],
    } }
    expect(migratePresentationWorkspace({
      schemaVersion: 1, activeProjectId: project.id, projects: [project],
      projectMetadata: { [project.id]: { revision: 1 } },
    }).projects[0]!.assets[0]!.imageEffects?.backgroundRemoval?.layerSource).toBe(presentationPptxSource(project.id, 'ppt/media/source-layer.wdp'))
    project.assets[0]!.imageEffects!.backgroundRemoval!.layerSource = 'data:image/vnd.ms-photo;base64,d2Rw'
    expect(() => migratePresentationWorkspace({
      schemaVersion: 1, activeProjectId: project.id, projects: [project],
      projectMetadata: { [project.id]: { revision: 1 } },
    })).toThrow('embedded or unresolved asset source')
    delete project.assets[0]!.imageEffects

    project.assets[0]!.source = 'data:image/png;base64,cG5n'
    expect(() => migratePresentationWorkspace({
      schemaVersion: 1,
      activeProjectId: project.id,
      projects: [project],
      projectMetadata: { [project.id]: { revision: 1 } },
    })).toThrow('embedded or unresolved asset source')
  })

  it('rejects future workspace schema versions', () => {
    const project = createBlankPresentationProject('Future project')
    expect(() => migratePresentationWorkspace({
      schemaVersion: 2,
      activeProjectId: project.id,
      projects: [project],
      projectMetadata: { [project.id]: { revision: 1 } },
    })).toThrow('Unsupported PowerPoint workspace schema version')
  })
})
