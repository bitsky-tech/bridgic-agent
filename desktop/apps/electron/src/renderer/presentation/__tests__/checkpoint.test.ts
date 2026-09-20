import { describe, expect, it } from 'bun:test'
import { createBlankPresentationProject } from '@/atoms/presentation'
import { migratePresentationCheckpoint } from '../checkpoint'

describe('PresentationCheckpoint', () => {
  it('keeps editable project content separate from Store and source metadata', () => {
    const project = createBlankPresentationProject('Pure project')
    const checkpoint = migratePresentationCheckpoint({
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

    expect(checkpoint.projects[0]).toEqual(project)
    expect(checkpoint.projects[0]).not.toHaveProperty('revision')
    expect(checkpoint.projects[0]).not.toHaveProperty('source')
    expect(checkpoint.projects[0]).not.toHaveProperty('savedRevision')
    expect(checkpoint.projects[0]).not.toHaveProperty('sourceProtected')
    expect(checkpoint.projectMetadata[project.id]).toEqual({
      revision: 8,
      savedRevision: 7,
      source: { path: '/Pure project.pptx', mtimeMs: 42 },
      sourceProtected: true,
    })
  })

  it('migrates the former document envelope without retaining it as a runtime model', () => {
    const project = createBlankPresentationProject('Legacy project')
    const checkpoint = migratePresentationCheckpoint({
      activeDocumentId: project.id,
      documents: [{
        ...project,
        revision: 5,
        savedRevision: 4,
        source: { path: '/Legacy project.pptx', mtimeMs: 10 },
      }],
    })

    expect(checkpoint).toMatchObject({
      schemaVersion: 1,
      activeProjectId: project.id,
      projects: [{ id: project.id, title: 'Legacy project' }],
      projectMetadata: { [project.id]: { revision: 5, savedRevision: 4, sourceProtected: true } },
    })
    expect(checkpoint.projects[0]).not.toHaveProperty('revision')
    expect(checkpoint.projects[0]).not.toHaveProperty('source')
  })
})
