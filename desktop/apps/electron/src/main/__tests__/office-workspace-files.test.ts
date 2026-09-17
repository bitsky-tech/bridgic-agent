import { afterEach, expect, it } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectOfficeFile } from '../office-files'
import { createOfficeWorkspaceFiles } from '../office-workspace-files'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

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
      if (!body) return [{ kind: 'folder', removable: false, path: work }]
      if (fail) throw new Error('service unavailable')
      const path = (body as { path: string }).path
      const target = join(work, basename(path))
      if (path !== target && !registered.has(target)) await copyFile(path, target)
      registered.add(target)
      return { kind: 'file', path: target }
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
      if (!body) return [{ kind: 'folder', removable: false, path: work }]
      if (fail) throw new Error('registration unavailable')
      return body
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
