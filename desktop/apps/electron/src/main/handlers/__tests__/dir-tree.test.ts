/**
 * Unit tests for the async dir walkers (`../dir-tree`): listDir (one lazy
 * level) and searchDir (names-only walk + shared scorer + per-hit sizes).
 * Real temp-dir fixtures, no fs mocking.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listDir, searchDir } from '../dir-tree'

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-tree-test-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(rel: string, content = 'x'): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

describe('listDir', () => {
  test('reads exactly one level: folders have no children, files have sizes', async () => {
    write('fapiao/高德打车发票/行程单.pdf', 'pdf-bytes')
    write('fapiao/发票汇总.xlsx', 'ab')
    const res = await listDir(path.join(root, 'fapiao'))
    if (!res.ok) throw new Error('expected ok')
    expect(res.nodes.map((n) => n.name)).toEqual(['高德打车发票', '发票汇总.xlsx'])
    expect(res.nodes[0]?.children).toBeUndefined() // 单层:子级等展开时再读
    expect(res.nodes[1]?.sizeBytes).toBe(2)
  })

  test('relBase prefixes relPaths for in-place grafting', async () => {
    write('a/b/c.txt')
    const res = await listDir(path.join(root, 'a/b'), 'a/b')
    if (!res.ok) throw new Error('expected ok')
    expect(res.nodes[0]?.relPath).toBe('a/b/c.txt')
  })

  test('sorts: normal folders, normal files, hidden folders, hidden files', async () => {
    write('beta.txt')
    write('alpha/keep')
    write('.hidden-dir/keep')
    write('.hidden-file')
    const res = await listDir(root)
    if (!res.ok) throw new Error('expected ok')
    expect(res.nodes.map((n) => n.name)).toEqual(['alpha', 'beta.txt', '.hidden-dir', '.hidden-file'])
  })

  test('directory symlinks list as folders (expandable later); broken links skipped', async () => {
    write('real/deep.txt')
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'))
    const res = await listDir(root)
    if (!res.ok) throw new Error('expected ok')
    // 排序基于 dirent(零 stat),软链不知道目标类型 → 按文件排在真目录后。
    expect(res.nodes.map((n) => n.name)).toEqual(['real', 'link'])
    expect(res.nodes.find((n) => n.name === 'link')?.kind).toBe('folder')
  })

  test('file symlinks appear as plain files', async () => {
    write('target.txt', '12345')
    fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'alias.txt'))
    const res = await listDir(root)
    if (!res.ok) throw new Error('expected ok')
    expect(res.nodes.find((n) => n.name === 'alias.txt')?.kind).toBe('file')
  })

  test('nonexistent root → not-found; file root → not-a-dir; empty dir → ok []', async () => {
    expect(await listDir(path.join(root, 'missing'))).toEqual({ ok: false, reason: 'not-found' })
    write('plain.txt')
    expect(await listDir(path.join(root, 'plain.txt'))).toEqual({ ok: false, reason: 'not-a-dir' })
    fs.mkdirSync(path.join(root, 'empty'))
    expect(await listDir(path.join(root, 'empty'))).toEqual({ ok: true, nodes: [] })
  })

  // chmod can't produce EACCES on Windows, and root bypasses the bit entirely.
  const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0

  // NOTE: this covers the POSIX-permission path (EACCES). macOS TCC — the
  // reason `denied` exists — rejects with EPERM instead (verified against
  // ~/Library/Safari, ~/Library/Mail and ~/Library/Cookies, which all return
  // EPERM without prompting). `listDir` treats both alike; only the EACCES
  // half is reachable from a test, since TCC state can't be faked.

  test.skipIf(!canDenyRead)('unreadable root → denied, not a generic error', async () => {
    const locked = path.join(root, 'locked')
    fs.mkdirSync(locked)
    fs.chmodSync(locked, 0o000)
    try {
      expect(await listDir(locked)).toEqual({ ok: false, reason: 'denied' })
    } finally {
      fs.chmodSync(locked, 0o700) // afterEach's rmSync needs to get back in
    }
  })
})

describe('searchDir', () => {
  test('finds deep entries with breadcrumbs and stats sizes for hits only', async () => {
    write('fapiao/高德打车发票/行程单.pdf', 'pdf-bytes')
    write('fapiao/滴滴出行发票.pdf')
    const res = await searchDir({
      roots: [{ mountId: 'mnt_1', mountName: 'fapiao', absPath: path.join(root, 'fapiao') }],
      query: '行程单',
    })
    expect(res.partial).toBe(false)
    const hit = res.hits[0]
    expect(hit?.name).toBe('行程单.pdf')
    expect(hit?.relPath).toBe('高德打车发票/行程单.pdf')
    expect(hit?.crumb).toEqual(['fapiao', '高德打车发票'])
    expect(hit?.sizeBytes).toBe(9)
    expect(hit?.mountId).toBe('mnt_1')
  })

  test('mount root itself is searchable by name (empty relPath)', async () => {
    fs.mkdirSync(path.join(root, 'docs'))
    const res = await searchDir({
      roots: [{ mountId: 'm', mountName: 'docs', absPath: path.join(root, 'docs') }],
      query: 'docs',
    })
    expect(res.hits[0]?.relPath).toBe('')
    expect(res.hits[0]?.kind).toBe('folder')
  })

  test('does not follow directory symlinks (loop safety)', async () => {
    write('real/inner.txt')
    // 自环:real/loop → root,跟随会无限展开。
    fs.symlinkSync(root, path.join(root, 'real', 'loop'))
    const res = await searchDir({
      roots: [{ mountId: 'm', mountName: 'r', absPath: root }],
      query: 'inner',
    })
    expect(res.hits.map((h) => h.relPath)).toEqual(['real/inner.txt'])
  })

  test('searches across multiple roots', async () => {
    write('a/from-a.txt')
    write('b/from-b.txt')
    const res = await searchDir({
      roots: [
        { mountId: 'ma', mountName: 'a', absPath: path.join(root, 'a') },
        { mountId: 'mb', mountName: 'b', absPath: path.join(root, 'b') },
      ],
      query: 'from',
    })
    expect(res.hits.map((h) => h.mountId).sort()).toEqual(['ma', 'mb'])
  })

  test('includes hidden directories inside an explicitly mounted folder', async () => {
    write('.build/private-report.md')
    write('visible-report.md')

    const workspace = await searchDir({
      roots: [{ mountId: 'work', mountName: 'project', absPath: root }],
      query: 'report',
    })
    expect(workspace.hits.map((h) => h.relPath)).toEqual([
      'visible-report.md',
      '.build/private-report.md',
    ])

    const explicit = await searchDir({
      roots: [{ mountId: 'explicit', mountName: 'project', absPath: root }],
      query: 'private-report',
    })
    expect(explicit.hits[0]?.relPath).toBe('.build/private-report.md')
  })

  test('empty query → no hits', async () => {
    write('a.txt')
    const res = await searchDir({
      roots: [{ mountId: 'm', mountName: 'r', absPath: root }],
      query: '  ',
    })
    expect(res).toEqual({ hits: [], total: 0, partial: false })
  })
})
