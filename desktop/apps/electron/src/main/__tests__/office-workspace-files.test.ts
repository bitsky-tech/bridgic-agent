import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { PresentationSourceMount } from '../../shared/presentation-host'
import * as officeFiles from '../office-files'
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
    const preserved = await service.save('session', { ...request, documentId: 'protected-import', source: await inspectOfficeFile(kind, imported.path), preserveSource: true, bytes: new TextEncoder().encode('editable copy') })
    expect(preserved.ok).toBe(true)
    if (!preserved.ok) throw new Error('save failed')
    expect(preserved.source.path).not.toBe(imported.path)
    expect(await readFile(imported.path, 'utf8')).toBe('new content')
    expect(await readFile(preserved.source.path, 'utf8')).toBe('editable copy')
    service = createService()
    const retried = await service.save('session', { ...request, documentId: 'protected-import', source: await inspectOfficeFile(kind, imported.path), preserveSource: true, bytes: new TextEncoder().encode('editable copy') })
    expect(retried.ok && retried.source.path).toBe(preserved.source.path)
    let copy = preserved.source
    for (const content of ['second edit', 'third edit']) {
      service = createService()
      const nextCopy = await service.save('session', { ...request, documentId: 'protected-import', suggestedName: basename(copy.path), source: copy, preserveSource: true, bytes: new TextEncoder().encode(content) })
      expect(nextCopy.ok).toBe(true)
      if (!nextCopy.ok) throw new Error('copy save failed')
      expect(nextCopy.source.path).toBe(preserved.source.path)
      expect(await readFile(nextCopy.source.path, 'utf8')).toBe(content)
      expect(await readFile(imported.path, 'utf8')).toBe('new content')
      copy = nextCopy.source
    }
    await writeFile(copy.path, 'changed outside the editor')
    await utimes(copy.path, new Date(), new Date(Date.now() + 10_000))
    expect(await service.save('session', { ...request, documentId: 'protected-import', source: copy, preserveSource: true })).toEqual({ ok: false, reason: 'conflict' })
    expect(await readFile(copy.path, 'utf8')).toBe('changed outside the editor')
    expect(notifications).toBeGreaterThan(0)
    const second = await service.save('session', { ...request, documentId: 'second' })
    expect(second.ok && second.fileName).toBe(`Report (3).${extension}`)
  })

  it(`${kind}: reuses protected saves of a new document and allocates a copy when protecting a previously saved original`, async () => {
    const root = await realpath(await testRoot())
    const work = join(root, '.work')
    await mkdir(work)
    const service = createOfficeWorkspaceFiles(async (_endpoint, body) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      const path = (body as { path: string }).path
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }, () => undefined)
    const input = { kind, documentId: 'new-protected', suggestedName: `New.${extension}`, preserveSource: true, bytes: new TextEncoder().encode('first edit') }
    const first = await service.save('session', input)
    if (!first.ok) throw new Error('save failed')
    const second = await service.save('session', { ...input, source: first.source, bytes: new TextEncoder().encode('second edit') })
    expect(second.ok && second.source.path).toBe(first.source.path)
    expect(await readdir(work)).toEqual([`New.${extension}`])
    const original = await service.save('session', { ...input, preserveSource: false, documentId: 'original', suggestedName: `Original.${extension}` })
    if (!original.ok) throw new Error('save failed')
    const copy = await service.save('session', { ...input, documentId: 'original', source: original.source, bytes: new TextEncoder().encode('protected edit') })
    expect(copy.ok && copy.source.path).not.toBe(original.source.path)
    expect(await readFile(original.source.path, 'utf8')).toBe('first edit')
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

  it(`${kind}: Save as allocates a sibling, retries it across restarts and rebinds subsequent saves`, async () => {
    const root = await realpath(await testRoot())
    const work = join(root, '.work')
    await mkdir(work)
    let failRegistration = false
    const backend = async (_endpoint: string, body?: unknown) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      if (failRegistration) throw new Error('registration unavailable')
      const path = (body as { path: string }).path
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }
    const createService = () => createOfficeWorkspaceFiles(backend, () => undefined)
    const input = { kind, documentId: 'document', suggestedName: `Report.${extension}`, bytes: new TextEncoder().encode('original') }
    const original = await createService().save('session', input)
    if (!original.ok) throw new Error('original save failed')

    const saveAs = { ...input, saveAs: true, source: original.source, bytes: new TextEncoder().encode('editable copy') }
    failRegistration = true
    await expect(createService().save('session', saveAs)).rejects.toThrow('file was saved')
    expect(await readFile(original.source.path, 'utf8')).toBe('original')
    expect((await readdir(work)).sort()).toEqual([`Report (2).${extension}`, `Report.${extension}`])
    failRegistration = false
    const copy = await createService().save('session', saveAs)
    if (!copy.ok) throw new Error('Save as retry failed')
    expect(copy.source.path).toBe(join(work, `Report (2).${extension}`))
    expect(await readFile(copy.source.path, 'utf8')).toBe('editable copy')
    expect((await readdir(work)).sort()).toEqual([`Report (2).${extension}`, `Report.${extension}`])

    const edit = { ...input, source: copy.source, bytes: new TextEncoder().encode('next edit') }
    failRegistration = true
    await expect(createService().save('session', edit)).rejects.toThrow('file was saved')
    failRegistration = false
    const updated = await createService().save('session', edit)
    if (!updated.ok) throw new Error('normal save retry failed')
    expect(updated.source.path).toBe(copy.source.path)
    expect(await readFile(original.source.path, 'utf8')).toBe('original')
    expect(await readFile(copy.source.path, 'utf8')).toBe('next edit')

    const secondCopy = await createService().save('session', { ...saveAs, source: updated.source, bytes: new TextEncoder().encode('another copy') })
    if (!secondCopy.ok) throw new Error('second Save as failed')
    expect(secondCopy.source.path).toBe(join(work, `Report (3).${extension}`))
    expect(await readFile(updated.source.path, 'utf8')).toBe('next edit')
    expect(await readFile(secondCopy.source.path, 'utf8')).toBe('another copy')

    await writeFile(secondCopy.source.path, 'external change')
    await utimes(secondCopy.source.path, new Date(), new Date(Date.now() + 10_000))
    expect(await createService().save('session', { ...input, source: secondCopy.source })).toEqual({ ok: false, reason: 'conflict' })
    expect(await readFile(secondCopy.source.path, 'utf8')).toBe('external change')
  })

  it(`${kind}: ordinary retries of a failed Save as keep the copy across repeated registration failures and restarts`, async () => {
    const root = await realpath(await testRoot())
    const work = join(root, '.work')
    await mkdir(work)
    let failRegistration = false
    const backend = async (_endpoint: string, body?: unknown) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      if (failRegistration) throw new Error('registration unavailable')
      const path = (body as { path: string }).path
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }
    const save = (input: Parameters<ReturnType<typeof createOfficeWorkspaceFiles>['save']>[1]) => createOfficeWorkspaceFiles(backend, () => undefined).save('session', input)
    const input = { kind, documentId: 'document', suggestedName: `Report.${extension}`, bytes: new TextEncoder().encode('original') }
    const original = await save(input)
    if (!original.ok) throw new Error('original save failed')
    failRegistration = true
    const edit = { ...input, source: original.source, bytes: new TextEncoder().encode('copy edit') }
    await expect(save({ ...edit, saveAs: true })).rejects.toThrow('file was saved')
    const copyPath = join(work, `Report (2).${extension}`)
    expect(await readFile(copyPath, 'utf8')).toBe('copy edit')
    expect(await readFile(original.source.path, 'utf8')).toBe('original')

    const retry = { ...edit, bytes: new TextEncoder().encode('newer copy edit') }
    await expect(save(retry)).rejects.toThrow('file was saved')
    expect(await readFile(original.source.path, 'utf8')).toBe('original')
    expect(await readFile(copyPath, 'utf8')).toBe('newer copy edit')
    failRegistration = false
    const acknowledged = await save(retry)
    if (!acknowledged.ok) throw new Error('ordinary retry failed')
    expect(acknowledged.source.path).toBe(copyPath)
    const continued = await save({ ...retry, source: acknowledged.source, bytes: new TextEncoder().encode('continued copy edit') })
    expect(continued.ok && continued.source.path).toBe(copyPath)
    expect(await readFile(original.source.path, 'utf8')).toBe('original')
    expect(await readFile(copyPath, 'utf8')).toBe('continued copy edit')
    expect((await readdir(work)).sort()).toEqual([`Report (2).${extension}`, `Report.${extension}`])
  })

  it(`${kind}: ordinary retry after failed Save as detects external copy changes`, async () => {
    const root = await realpath(await testRoot())
    const work = join(root, '.work')
    await mkdir(work)
    const originalPath = join(work, `Report.${extension}`)
    await writeFile(originalPath, 'original')
    let failRegistration = true
    const backend = async (_endpoint: string, body?: unknown) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      if (failRegistration) throw new Error('registration unavailable')
      const path = (body as { path: string }).path
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }
    const input = { kind, documentId: 'document', suggestedName: `Report.${extension}`, source: await inspectOfficeFile(kind, originalPath), bytes: new TextEncoder().encode('copy edit') }
    await expect(createOfficeWorkspaceFiles(backend, () => undefined).save('session', { ...input, saveAs: true })).rejects.toThrow('file was saved')
    const copyPath = join(work, `Report (2).${extension}`)
    await writeFile(copyPath, 'external change')
    await utimes(copyPath, new Date(), new Date(Date.now() + 10_000))
    failRegistration = false
    expect(await createOfficeWorkspaceFiles(backend, () => undefined).save('session', input)).toEqual({ ok: false, reason: 'conflict' })
    expect(await readFile(originalPath, 'utf8')).toBe('original')
    expect(await readFile(copyPath, 'utf8')).toBe('external change')
    expect((await readdir(work)).sort()).toEqual([`Report (2).${extension}`, `Report.${extension}`])
  })

  it(`${kind}: Save as retries use the newer ordinary retry intent for the same unacknowledged copy`, async () => {
    const root = await realpath(await testRoot())
    const work = join(root, '.work')
    await mkdir(work)
    let failRegistration = false
    const backend = async (_endpoint: string, body?: unknown) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      if (failRegistration) throw new Error('registration unavailable')
      const path = (body as { path: string }).path
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }
    const save = (input: Parameters<ReturnType<typeof createOfficeWorkspaceFiles>['save']>[1]) => createOfficeWorkspaceFiles(backend, () => undefined).save('session', input)
    const input = { kind, documentId: 'document', suggestedName: `Report.${extension}`, bytes: new TextEncoder().encode('original') }
    const original = await save(input)
    if (!original.ok) throw new Error('original save failed')
    failRegistration = true
    const firstEdit = { ...input, source: original.source, bytes: new TextEncoder().encode('first copy edit') }
    await expect(save({ ...firstEdit, saveAs: true })).rejects.toThrow('file was saved')
    const copyPath = join(work, `Report (2).${extension}`)
    const newerEdit = { ...firstEdit, bytes: new TextEncoder().encode('newer copy edit') }
    await expect(save(newerEdit)).rejects.toThrow('file was saved')
    expect(await readFile(copyPath, 'utf8')).toBe('newer copy edit')
    failRegistration = false
    const retried = await save({ ...newerEdit, saveAs: true })
    expect(retried.ok && retried.source.path).toBe(copyPath)
    expect(await readFile(original.source.path, 'utf8')).toBe('original')
    expect(await readFile(copyPath, 'utf8')).toBe('newer copy edit')
    expect((await readdir(work)).sort()).toEqual([`Report (2).${extension}`, `Report.${extension}`])
  })

  it(`${kind}: ordinary retry recovers the Save as target when promoting its receipt fails`, async () => {
    const root = await realpath(await testRoot())
    const work = join(root, '.work')
    await mkdir(work)
    const backend = async (_endpoint: string, body?: unknown) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      const path = (body as { path: string }).path
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }
    const input = { kind, documentId: 'document', suggestedName: `Report.${extension}`, bytes: new TextEncoder().encode('original') }
    const service = createOfficeWorkspaceFiles(backend, () => undefined)
    const original = await service.save('session', input)
    if (!original.ok) throw new Error('original save failed')
    const receiptPath = join(root, '.internal', 'office', 'writes', `${createHash('sha256').update(`session:${kind}:document`).digest('hex')}.json`)
    const edit = { ...input, source: original.source, bytes: new TextEncoder().encode('copy edit') }
    const writeBytes = officeFiles.writeOfficeBytes
    const writer = spyOn(officeFiles, 'writeOfficeBytes').mockImplementation((path, bytes) => {
      if (path === receiptPath) return Promise.reject(new Error('receipt promotion unavailable'))
      return writeBytes(path, bytes)
    })
    try {
      await expect(service.save('session', { ...edit, saveAs: true })).rejects.toThrow('receipt promotion unavailable')
    } finally { writer.mockRestore() }
    const copyPath = join(work, `Report (2).${extension}`)
    expect(await readFile(copyPath, 'utf8')).toBe('copy edit')
    const retried = await createOfficeWorkspaceFiles(backend, () => undefined).save('session', edit)
    expect(retried.ok && retried.source.path).toBe(copyPath)
    expect(await readFile(original.source.path, 'utf8')).toBe('original')
    expect(await readFile(copyPath, 'utf8')).toBe('copy edit')
    expect((await readdir(work)).sort()).toEqual([`Report (2).${extension}`, `Report.${extension}`])
  })

  it(`${kind}: an unpromoted Save as intent takes precedence over an earlier protected copy`, async () => {
    const root = await realpath(await testRoot())
    const work = join(root, '.work')
    await mkdir(work)
    const originalPath = join(work, `Report.${extension}`)
    await writeFile(originalPath, 'protected original')
    let failRegistration = true
    const backend = async (_endpoint: string, body?: unknown) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      if (failRegistration) throw new Error('registration unavailable')
      const path = (body as { path: string }).path
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }
    const save = (input: Parameters<ReturnType<typeof createOfficeWorkspaceFiles>['save']>[1]) => createOfficeWorkspaceFiles(backend, () => undefined).save('session', input)
    const input = { kind, documentId: 'document', suggestedName: `Report.${extension}`, source: await inspectOfficeFile(kind, originalPath), preserveSource: true, bytes: new TextEncoder().encode('protected copy edit') }
    await expect(save(input)).rejects.toThrow('file was saved')
    const earlierCopyPath = join(work, `Report (2).${extension}`)
    const receiptPath = join(root, '.internal', 'office', 'writes', `${createHash('sha256').update(`session:${kind}:document`).digest('hex')}.json`)
    const priorReceipt = await readFile(receiptPath, 'utf8')
    failRegistration = false
    const saveAsEdit = { ...input, bytes: new TextEncoder().encode('Save as copy edit') }
    const writeBytes = officeFiles.writeOfficeBytes
    const writer = spyOn(officeFiles, 'writeOfficeBytes').mockImplementation((path, bytes) => {
      if (path === receiptPath) return Promise.reject(new Error('receipt promotion unavailable'))
      return writeBytes(path, bytes)
    })
    try {
      await expect(save({ ...saveAsEdit, saveAs: true })).rejects.toThrow('receipt promotion unavailable')
    } finally { writer.mockRestore() }
    const saveAsCopyPath = join(work, `Report (3).${extension}`)
    expect(await readFile(saveAsCopyPath, 'utf8')).toBe('Save as copy edit')
    expect(await readFile(receiptPath, 'utf8')).toBe(priorReceipt)
    const retried = await save(saveAsEdit)
    expect(retried.ok && retried.source.path).toBe(saveAsCopyPath)
    expect(await readFile(originalPath, 'utf8')).toBe('protected original')
    expect(await readFile(earlierCopyPath, 'utf8')).toBe('protected copy edit')
    expect(await readFile(saveAsCopyPath, 'utf8')).toBe('Save as copy edit')
    expect((await readdir(work)).sort()).toEqual([`Report (2).${extension}`, `Report (3).${extension}`, `Report.${extension}`])
  })

  it(`${kind}: protected Save as keeps ordinary saves on the acknowledged copy`, async () => {
    const root = await realpath(await testRoot())
    const work = join(root, '.work')
    await mkdir(work)
    const service = createOfficeWorkspaceFiles(async (_endpoint, body) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      const path = (body as { path: string }).path
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }, () => undefined)
    const path = join(work, `Protected.${extension}`)
    await writeFile(path, 'protected original')
    const input = { kind, documentId: 'protected', source: await inspectOfficeFile(kind, path), suggestedName: `Protected.${extension}`, preserveSource: true, bytes: new TextEncoder().encode('copy') }
    const copy = await service.save('session', { ...input, saveAs: true })
    if (!copy.ok) throw new Error('protected Save as failed')
    expect(copy.source.path).toBe(join(work, `Protected (2).${extension}`))
    const updated = await service.save('session', { ...input, source: copy.source, bytes: new TextEncoder().encode('updated copy') })
    expect(updated.ok && updated.source.path).toBe(copy.source.path)
    expect(await readFile(path, 'utf8')).toBe('protected original')
    expect(await readFile(copy.source.path, 'utf8')).toBe('updated copy')
    expect((await readdir(work)).sort()).toEqual([`Protected (2).${extension}`, `Protected.${extension}`])
  })

  it(`${kind}: retrying Save as never overwrites external changes to its unacknowledged copy`, async () => {
    const root = await realpath(await testRoot())
    const work = join(root, '.work')
    await mkdir(work)
    let failRegistration = true
    const backend = async (_endpoint: string, body?: unknown) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      if (failRegistration) throw new Error('registration unavailable')
      const path = (body as { path: string }).path
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }
    const input = { kind, documentId: 'new-protected', saveAs: true, preserveSource: true, suggestedName: `New.${extension}`, bytes: new TextEncoder().encode('first copy') }
    await expect(createOfficeWorkspaceFiles(backend, () => undefined).save('session', input)).rejects.toThrow('file was saved')
    failRegistration = false
    const restored = await createOfficeWorkspaceFiles(backend, () => undefined).save('session', input)
    if (!restored.ok) throw new Error('new Save as retry failed')
    expect(await readdir(work)).toEqual([`New.${extension}`])
    await writeFile(restored.source.path, 'external change')
    await utimes(restored.source.path, new Date(), new Date(Date.now() + 10_000))
    expect(await createOfficeWorkspaceFiles(backend, () => undefined).save('session', input)).toEqual({ ok: false, reason: 'conflict' })
    expect(await readFile(restored.source.path, 'utf8')).toBe('external change')
    expect(await readdir(work)).toEqual([`New.${extension}`])
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
