/**
 * Tests for fileTree.ts — lazy-level grafting (rebase + graft) and display
 * helpers. The search scorer's tests live in shared/__tests__/file-search.
 */
import { describe, expect, test } from 'bun:test'
import type { DirTreeNode } from '../../../shared/dir-tree'
import { extColor, findNode, graftTree, pruneExpanded, rebaseTree } from '../fileTree'

function folder(relPath: string, children?: DirTreeNode[]): DirTreeNode {
  const name = relPath.split('/').pop() ?? relPath
  return { name, kind: 'folder', relPath, sizeBytes: null, ...(children ? { children } : {}) }
}

function file(relPath: string, size = 1): DirTreeNode {
  const name = relPath.split('/').pop() ?? relPath
  return { name, kind: 'file', relPath, sizeBytes: size }
}

describe('rebaseTree', () => {
  test('prefixes relPaths recursively; empty prefix is a no-op', () => {
    const level = [folder('sub', [file('sub/deep.txt')]), file('a.txt')]
    const rebased = rebaseTree(level, 'parent/dir')
    expect(rebased[0]?.relPath).toBe('parent/dir/sub')
    expect(rebased[0]?.children?.[0]?.relPath).toBe('parent/dir/sub/deep.txt')
    expect(rebased[1]?.relPath).toBe('parent/dir/a.txt')
    expect(rebaseTree(level, '')).toBe(level)
  })
})

describe('graftTree', () => {
  const base: DirTreeNode[] = [folder('fapiao'), file('用户画像.xlsx')]

  test('grafts a loaded level into the target node, immutably', () => {
    const grafted = graftTree(base, 'fapiao', { children: [file('fapiao/行程单.pdf')] })
    expect(grafted[0]?.children?.[0]?.relPath).toBe('fapiao/行程单.pdf')
    // 原树不被修改(immutability)。
    expect(base[0]?.children).toBeUndefined()
    // 未涉及的兄弟节点引用复用。
    expect(grafted[1]).toBe(base[1])
  })

  test('grafts deep targets through the ancestor chain only', () => {
    const tree = [folder('a', [folder('a/b')])]
    const grafted = graftTree(tree, 'a/b', { children: [file('a/b/c.txt')] })
    expect(grafted[0]?.children?.[0]?.children?.[0]?.relPath).toBe('a/b/c.txt')
  })

  test('marks unreadable on load failure (drops stale children)', () => {
    const tree = [folder('a', [file('a/x.txt')])]
    const grafted = graftTree(tree, 'a', { unreadable: true })
    expect(grafted[0]?.unreadable).toBe(true)
    expect(grafted[0]?.children).toBeUndefined()
  })

  test('clears stale unreadable when a later load succeeds', () => {
    const tree: DirTreeNode[] = [
      { name: 'a', kind: 'folder', relPath: 'a', sizeBytes: null, unreadable: true },
    ]
    const grafted = graftTree(tree, 'a', { children: [] })
    expect(grafted[0]?.unreadable).toBeUndefined()
    expect(grafted[0]?.children).toEqual([])
  })

  test('unknown relPath leaves the tree unchanged', () => {
    expect(graftTree(base, 'nope/nothing', { children: [] })).toEqual(base)
  })
})

describe('findNode', () => {
  test('walks the ancestor chain; misses return null', () => {
    const tree = [folder('a', [folder('a/b', [file('a/b/c.txt')])]), file('z.txt')]
    expect(findNode(tree, 'a/b/c.txt')?.name).toBe('c.txt')
    expect(findNode(tree, 'z.txt')?.kind).toBe('file')
    expect(findNode(tree, 'a/missing')).toBeNull()
    // 祖先尚未加载(无 children)→ 找不到,而不是误匹配。
    expect(findNode([folder('x')], 'x/deep.txt')).toBeNull()
  })
})

describe('pruneExpanded', () => {
  test('keeps a top-level expanded folder that still exists', () => {
    const nodes = [folder('a'), file('b.txt')]
    expect([...pruneExpanded(new Set(['a']), nodes)]).toEqual(['a'])
  })

  test('drops a top-level entry the (loaded) root no longer lists — vanished', () => {
    const nodes = [folder('a')]
    expect([...pruneExpanded(new Set(['a', 'gone']), nodes)]).toEqual(['a'])
  })

  test('drops an entry that became a file or unreadable', () => {
    const nodes = [
      file('nowfile'),
      { name: 'noperm', kind: 'folder' as const, relPath: 'noperm', sizeBytes: null, unreadable: true as const },
    ]
    expect([...pruneExpanded(new Set(['nowfile', 'noperm']), nodes)]).toEqual([])
  })

  test('KEEPS a deep entry whose parent level is not loaded yet (reload window)', () => {
    // Root re-read dropped deeper levels: `a` has no children loaded → we
    // cannot yet judge `a/b`, so it must survive until the self-heal reloads.
    const nodes = [folder('a')]
    expect([...pruneExpanded(new Set(['a', 'a/b']), nodes)]).toEqual(['a', 'a/b'])
  })

  test('drops a deep entry once its parent IS loaded and no longer lists it', () => {
    const nodes = [folder('a', [file('a/keep.txt')])] // parent loaded, no a/b
    expect([...pruneExpanded(new Set(['a', 'a/b']), nodes)]).toEqual(['a'])
  })

  test('keeps a deep entry the loaded parent still lists as a folder', () => {
    const nodes = [folder('a', [folder('a/b')])]
    expect([...pruneExpanded(new Set(['a', 'a/b']), nodes)]).toEqual(['a', 'a/b'])
  })
})

describe('extColor', () => {
  test('maps extensions to design palette; folders brand-blue; default tertiary', () => {
    expect(extColor('a.pdf', 'file')).toBe('text-[#E2574C]')
    expect(extColor('b.xlsx', 'file')).toBe('text-[#3FA86B]')
    expect(extColor('c.zip', 'file')).toBe('text-[#E0A33A]')
    expect(extColor('d.docx', 'file')).toBe('text-[#3B82C4]')
    expect(extColor('e.weird', 'file')).toBe('text-text-tertiary')
    expect(extColor('any', 'folder')).toBe('text-brand-blue')
  })
})
