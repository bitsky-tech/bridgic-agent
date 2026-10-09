import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, utimes, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOfficeRecoveryStore, inspectOfficeFile, saveOfficeFile } from '../office-files'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'office-save-')); roots.push(path); return path }

describe('Office source files and durable recovery', () => {
  for (const [kind, extension] of [['word', 'docx'], ['excel', 'xlsx'], ['presentation', 'pptx']] as const) {
    it(`protects the ${kind} original even when Save as selects the same file or an alias`, async () => {
      const directory = await root()
      const path = join(directory, `original.${extension}`)
      await writeFile(path, 'full-fidelity original')
      const source = await inspectOfficeFile(kind, path)
      const request = { kind, source, preserveSource: true, bytes: new TextEncoder().encode('converted copy'), suggestedName: `copy.${extension}`, saveAs: true }
      expect(await saveOfficeFile(request, path, true)).toEqual({ ok: false, reason: 'source-protected' })
      if (process.platform !== 'win32') {
        const alias = join(directory, `alias.${extension}`)
        await symlink(path, alias)
        expect(await saveOfficeFile(request, alias, true)).toEqual({ ok: false, reason: 'source-protected' })
      }
      expect(await readFile(path, 'utf8')).toBe('full-fidelity original')
      const copy = join(directory, `copy.${extension}`)
      expect(await saveOfficeFile(request, copy, true)).toMatchObject({ ok: true })
      expect(await readFile(copy, 'utf8')).toBe('converted copy')
    })

    it(`saves an Agent ${kind} copy to an explicit new path without overwriting an existing destination`, async () => {
      const directory = await root()
      const path = join(directory, `original.${extension}`)
      const destination = join(directory, `copy.${extension}`)
      await writeFile(path, 'original')
      const source = await inspectOfficeFile(kind, path)
      const request = { kind, source, destination, preserveSource: true, saveAs: true, bytes: new TextEncoder().encode('copy'), suggestedName: `copy.${extension}` }
      expect(await saveOfficeFile(request, destination)).toMatchObject({ ok: true })
      expect(await saveOfficeFile(request, destination)).toEqual({ ok: false, reason: 'conflict' })
      expect(await readFile(path, 'utf8')).toBe('original')
      expect(await readFile(destination, 'utf8')).toBe('copy')
    })

    it(`saves ${kind} explicitly and preserves an externally changed file`, async () => {
      const path = join(await root(), `report.${extension}`)
      await writeFile(path, 'original')
      const source = await inspectOfficeFile(kind, path)
      const request = { kind, source, bytes: new TextEncoder().encode('edited'), suggestedName: `report.${extension}` }
      expect(await saveOfficeFile(request, path)).toMatchObject({ ok: true })
      expect(await readFile(path, 'utf8')).toBe('edited')
      await writeFile(path, 'external')
      await utimes(path, new Date(), new Date(Date.now() + 10_000))
      expect(await saveOfficeFile(request, path)).toEqual({ ok: false, reason: 'conflict' })
      expect(await readFile(path, 'utf8')).toBe('external')
    })
  }
  it('restores independent Excel Session drafts through a fresh store instance', async () => {
    const directory = await root()
    const first = createOfficeRecoveryStore(directory)
    await Promise.all([first.write('excel', 'session-a', '{"draft":1}'), first.write('excel', 'session-b', '{"draft":2}')])
    const next = createOfficeRecoveryStore(directory)
    expect(await next.read('excel', 'session-a')).toBe('{"draft":1}')
    expect(await next.read('excel', 'session-b')).toBe('{"draft":2}')
  })
})
