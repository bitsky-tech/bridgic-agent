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

  test('grafts success and failure states immutably along the target chain', () => {
    const topLevel = graftTree(base, 'fapiao', { children: [file('fapiao/行程单.pdf')] })
    expect(topLevel[0]?.children?.[0]?.relPath).toBe('fapiao/行程单.pdf')
    // The original tree remains unchanged.
    expect(base[0]?.children).toBeUndefined()
    // Unaffected sibling nodes retain their references.
    expect(topLevel[1]).toBe(base[1])

    const deepTree = [folder('a', [folder('a/b')])]
    const deep = graftTree(deepTree, 'a/b', { children: [file('a/b/c.txt')] })
    expect(deep[0]?.children?.[0]?.children?.[0]?.relPath).toBe('a/b/c.txt')

    const staleTree = [folder('a', [file('a/x.txt')])]
    const failed = graftTree(staleTree, 'a', { unreadable: true })
    expect(failed[0]?.unreadable).toBe(true)
    expect(failed[0]?.children).toBeUndefined()

    const unreadableTree: DirTreeNode[] = [
      { name: 'a', kind: 'folder', relPath: 'a', sizeBytes: null, unreadable: true },
    ]
    const recovered = graftTree(unreadableTree, 'a', { children: [] })
    expect(recovered[0]?.unreadable).toBeUndefined()
    expect(recovered[0]?.children).toEqual([])

    expect(graftTree(base, 'nope/nothing', { children: [] })).toEqual(base)
  })
})

describe('findNode', () => {
  test('walks the ancestor chain; misses return null', () => {
    const tree = [folder('a', [folder('a/b', [file('a/b/c.txt')])]), file('z.txt')]
    expect(findNode(tree, 'a/b/c.txt')?.name).toBe('c.txt')
    expect(findNode(tree, 'z.txt')?.kind).toBe('file')
    expect(findNode(tree, 'a/missing')).toBeNull()
    // An unloaded ancestor with no children yields no match instead of a false positive.
    expect(findNode([folder('x')], 'x/deep.txt')).toBeNull()
  })
})

describe('pruneExpanded', () => {
  test('keeps only expansions that loaded tree levels can validate', () => {
    expect([...pruneExpanded(new Set(['a']), [folder('a'), file('b.txt')])]).toEqual(['a'])
    expect([...pruneExpanded(new Set(['a', 'gone']), [folder('a')])]).toEqual(['a'])

    const invalidNodes = [
      file('nowfile'),
      { name: 'noperm', kind: 'folder' as const, relPath: 'noperm', sizeBytes: null, unreadable: true as const },
    ]
    expect([...pruneExpanded(new Set(['nowfile', 'noperm']), invalidNodes)]).toEqual([])

    // Root re-read dropped deeper levels: `a` has no children loaded → we
    // cannot yet judge `a/b`, so it must survive until the self-heal reloads.
    expect([...pruneExpanded(new Set(['a', 'a/b']), [folder('a')])]).toEqual(['a', 'a/b'])

    const missingDeep = [folder('a', [file('a/keep.txt')])] // parent loaded, no a/b
    expect([...pruneExpanded(new Set(['a', 'a/b']), missingDeep)]).toEqual(['a'])

    const presentDeep = [folder('a', [folder('a/b')])]
    expect([...pruneExpanded(new Set(['a', 'a/b']), presentDeep)]).toEqual(['a', 'a/b'])
  })
})

describe('extColor', () => {
  test('maps extensions to design palette; folders brand-blue; default tertiary', () => {
    expect(extColor('a.pdf', 'file')).toBe('text-[#E2574C]')
    expect(extColor('b.xlsx', 'file')).toBe('text-[#3FA86B]')
    expect(extColor('c.zip', 'file')).toBe('text-[#E0A33A]')
    expect(extColor('d.docx', 'file')).toBe('text-[#3B82C4]')
    expect(extColor('e.weird', 'file')).toBe('text-text-tertiary')
    expect(extColor('any', 'folder')).toBe('text-text-accent')
  })
})
