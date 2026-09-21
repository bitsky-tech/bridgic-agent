import { afterEach, describe, expect, it } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { PresentationSourceMount } from '../../shared/presentation-host'
import { inspectOfficeFile } from '../office-files'
import { createOfficeWorkspaceFiles } from '../office-workspace-files'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function testRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'office-workspace-files-'))
  roots.push(path)
  return path
}

for (const [kind, extension] of [['word', 'docx'], ['excel', 'xlsx'], ['presentation', 'pptx']] as const) {
  it(`${kind}: registers new and imported files, reuses identities and retries failed registration across process restarts`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'office-workspace-')))
    roots.push(root)
    const work = join(root, '.work')
    await mkdir(work)
    const registered = new Set<string>()
    let fail = false
    let notifications = 0
    const createService = () => createOfficeWorkspaceFiles(async (_endpoint, body) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      if (fail) throw new Error('service unavailable')
      const path = (body as { path: string }).path
      const target = join(work, basename(path))
      if (path !== target && !registered.has(target)) await copyFile(path, target)
      registered.add(target)
      return { id: `file-${basename(target)}`, name: basename(target), kind: 'file', path: target, exists: true }
    }, () => { notifications++ })
    let service = createService()
    const request = { kind, documentId: 'new-document', managed: true, suggestedName: `Report.${extension}`, bytes: new TextEncoder().encode('new content') }
    fail = true
    await expect(service.save('session', request)).rejects.toThrow('service unavailable')
    fail = false
    service = createService()
    const saved = await service.save('session', request)
    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error('save failed')
    expect(await readdir(work)).toEqual([`Report.${extension}`])
    expect(registered.has(saved.source.path)).toBe(true)
    expect(await readFile(saved.source.path, 'utf8')).toBe('new content')
    fail = true
    const next = { ...request, source: saved.source, bytes: new TextEncoder().encode('updated content') }
    await expect(service.save('session', next)).rejects.toThrow('service unavailable')
    fail = false
    service = createService()
    expect((await service.save('session', next)).ok).toBe(true)
    expect(await readFile(saved.source.path, 'utf8')).toBe('updated content')
    const external = join(root, `Original.${extension}`)
    await writeFile(external, 'original')
    const imported = await service.prepare('session', kind, external)
    expect(imported.path).toBe(join(work, `Original.${extension}`))
    const updated = await service.save('session', { ...request, documentId: 'import', source: imported })
    expect(updated.ok).toBe(true)
    expect((await service.prepare('session', kind, external)).path).toBe(imported.path)
    expect(await readFile(external, 'utf8')).toBe('original')
    expect(await readFile(imported.path, 'utf8')).toBe('new content')
    expect(notifications).toBeGreaterThan(0)
    const second = await service.save('session', { ...request, documentId: 'second' })
    expect(second.ok && second.fileName).toBe(`Report (2).${extension}`)
  })

  it(`${kind}: a recovery receipt never acknowledges unrelated file content`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'office-receipt-')))
    roots.push(root)
    const work = join(root, '.work')
    await mkdir(work)
    const path = join(work, `Report.${extension}`)
    await writeFile(path, 'old content')
    const source = await inspectOfficeFile(kind, path)
    let fail = true
    const backend = async (_endpoint: string, body?: unknown) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      if (fail) throw new Error('registration unavailable')
      const target = (body as { path: string }).path
      return { id: `file-${basename(target)}`, name: basename(target), kind: 'file', path: target, exists: true }
    }
    const input = { kind, documentId: 'document', source, suggestedName: `Report.${extension}`, bytes: new TextEncoder().encode('my edit') }
    await expect(createOfficeWorkspaceFiles(backend, () => undefined).save('session', input)).rejects.toThrow('file was saved')
    await writeFile(path, 'different file content')
    await utimes(path, new Date(), new Date(Date.now() + 10_000))
    fail = false
    expect(await createOfficeWorkspaceFiles(backend, () => undefined).save('session', input)).toEqual({ ok: false, reason: 'conflict' })
    expect(await readFile(path, 'utf8')).toBe('different file content')
  })
}

describe('PowerPoint Session source mounts', () => {
  it('registers user-inserted sources without creating hidden presentation assets', async () => {
    const root = await testRoot()
    const workPath = join(root, '.work')
    const externalPath = join(root, 'external.png')
    await mkdir(workPath)
    await writeFile(externalPath, 'external')
    const workMount: PresentationSourceMount = {
      id: 'work-mount', name: '.work', path: workPath, kind: 'folder', exists: true,
      size_bytes: null, item_count: 0, removable: false, created_at: new Date(0).toISOString(),
    }
    const registered: string[] = []
    const request = async (_path: string, body?: unknown): Promise<unknown> => {
      if (!body) return [workMount]
      const path = (body as { path: string }).path
      registered.push(path)
      return {
        id: `mount-${basename(path)}`, name: basename(path), path, kind: 'file', exists: true,
        size_bytes: 8, item_count: null, removable: true, created_at: new Date(0).toISOString(),
      } satisfies PresentationSourceMount
    }
    const changed: string[] = []
    const files = createOfficeWorkspaceFiles(request, (sessionId) => { changed.push(sessionId) })

    const external = await files.mountPresentationSource('session-a', {
      fileName: 'external.png', mimeType: 'image/png', path: externalPath,
    })
    expect(external).toMatchObject({ id: 'mount-external.png', name: 'external.png' })
    expect(registered).toHaveLength(1)
    const registeredPath = registered[0]!
    expect(external.path).toBe(registeredPath)
    expect(basename(registeredPath)).toBe('external.png')

    const generated = await files.mountPresentationSource('session-a', {
      dataBase64: Buffer.from('generated').toString('base64'), fileName: 'generated.txt', mimeType: 'text/plain',
    })
    expect(generated).toMatchObject({ id: expect.stringMatching(/^mount-[a-f0-9]{64}-generated\.txt$/) })
    expect(generated.path).toMatch(/\.work\/[a-f0-9]{64}-generated\.txt$/)
    expect(await readFile(generated.path, 'utf8')).toBe('generated')
    expect(registered).toHaveLength(2)
    expect(changed).toEqual(['session-a', 'session-a'])

    await expect(files.mountPresentationSource('session-a', {
      fileName: 'escaped.png', mimeType: 'image/png', path: '../external.png',
    })).rejects.toThrow('must stay inside the Session workspace')
    await expect(files.mountPresentationSource('session-a', {
      dataBase64: 'not=base64', fileName: 'invalid.png', mimeType: 'image/png',
    })).rejects.toThrow('embedded source data is invalid')
  })
})
