/**
 * Tests for composer/paste-classify.ts — the pure paste→mount decision layer.
 *
 * No DOM needed: `classifyPaste` takes plain text + a File[] directly. `File`
 * is a Bun/WHATWG global, so we construct fixtures with `new File(...)`.
 */
import { describe, it, expect } from 'bun:test'
import { classifyPaste, resolveFileItems, type PasteItem } from '../pasteClassify'
import { LARGE_TEXT_THRESHOLD } from '../pasteConstants'

const file = (name: string, type: string): File => new File(['x'], name, { type })

describe('classifyPaste', () => {
  it('files win over everything (even path-looking text)', () => {
    const png = file('shot.png', 'image/png')
    expect(classifyPaste('/abs/path', [png])).toEqual([{ kind: 'file', file: png }])
  })

  it('large text → text item', () => {
    const big = 'a'.repeat(LARGE_TEXT_THRESHOLD)
    expect(classifyPaste(big, [])).toEqual([{ kind: 'text', text: big }])
  })

  it('short ordinary text → null (native insertion)', () => {
    expect(classifyPaste('just a short note', [])).toBeNull()
    expect(classifyPaste('a'.repeat(LARGE_TEXT_THRESHOLD - 1), [])).toBeNull()
  })

  // Type-driven, not content-guessing: with NO file object in the clipboard,
  // text that merely looks like a path (incl. a slash command) is ordinary
  // text → null → native editor insertion. The clipboard cannot distinguish a
  // path string from natural language (both are `text/plain`), so we no longer
  // guess — this is what once produced the `/build …` phantom-empty-session bug.
  it('path-looking PLAIN TEXT (no file object) → null, never a mount', () => {
    expect(classifyPaste('/Users/me/a.txt', [])).toBeNull()
    expect(classifyPaste('C:\\Users\\me\\a.txt', [])).toBeNull()
    expect(classifyPaste('/build 帮我做一个目录文件统计工具', [])).toBeNull()
  })
})

describe('resolveFileItems', () => {
  it('upgrades a file item to a path item when a real path resolves', () => {
    const f = file('a.sh', 'text/x-sh')
    expect(resolveFileItems([{ kind: 'file', file: f }], () => '/abs/a.sh')).toEqual([
      { kind: 'path', path: '/abs/a.sh' },
    ])
  })

  it('keeps the file item when no path resolves (screenshot / image data)', () => {
    const f = file('shot.png', 'image/png')
    expect(resolveFileItems([{ kind: 'file', file: f }], () => '')).toEqual([
      { kind: 'file', file: f },
    ])
  })

  it('leaves path / text items untouched', () => {
    const items: PasteItem[] = [
      { kind: 'path', path: '/x' },
      { kind: 'text', text: 'y' },
    ]
    expect(resolveFileItems(items, () => '/unused')).toEqual(items)
  })
})
