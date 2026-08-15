/**
 * Classify a clipboard paste into the composer's paste→mount items.
 *
 * Pure decision layer (no IO): given the paste's plain text + files, decides
 * whether the paste should become session-file mount(s) and of what kind.
 * Returns null when the paste is ordinary text that should fall through to the
 * editor's native insertion. The actual upload + mount is driven by
 * `pasteToSessionFilesAtom` (atoms/mounts.ts); this file only decides.
 *
 * Type-driven, NOT content-guessing: only a real FILE OBJECT in the clipboard
 * (Finder/Explorer copy, drag-drop) becomes a mount. Plain text — even when it
 * looks like an absolute path — is NEVER auto-mounted: the clipboard cannot
 * distinguish a path string from natural language or a slash command (all are
 * `text/plain` with `DataTransferItem.kind === 'string'`), so guessing produced
 * false positives (`/build …` → routed to mount → phantom empty session). Large
 * text still becomes a `.txt` attachment — that's a size threshold, not a
 * path/semantics guess.
 *
 * Order (first match wins): files → large text → null.
 */
import { LARGE_TEXT_THRESHOLD } from './pasteConstants'

/** One unit of paste content destined to become a session-file mount. */
export type PasteItem =
  | { kind: 'path'; path: string } // a file object resolved to its real on-disk path (see resolveFileItems)
  | { kind: 'file'; file: File } // a pasted / dropped image / file blob
  | { kind: 'text'; text: string } // a large text blob → saved as .txt

/**
 * Decide what a paste becomes. Null = let the editor insert it natively.
 *
 * @param text - the paste's `text/plain` payload (may be empty)
 * @param files - the paste's file payload (images / files), may be empty
 */
export function classifyPaste(text: string, files: File[]): PasteItem[] | null {
  if (files.length > 0) return files.map((file) => ({ kind: 'file', file }))
  if (text.length >= LARGE_TEXT_THRESHOLD) return [{ kind: 'text', text }]
  return null
}

/**
 * Upgrade `file` items to `path` items when the platform can resolve a file's
 * real absolute path (Electron `webUtils.getPathForFile`).
 *
 * A pasted/dropped file that exists on disk (e.g. copied from Finder) is better
 * mounted in place by its original path. Files with no on-disk source
 * (clipboard image data / screenshots) resolve to '' and stay `file` items,
 * then become Session-owned uploaded mounts in `pasteToSessionFilesAtom`.
 *
 * @param getPath - resolver returning the absolute path, or '' when unavailable
 */
export function resolveFileItems(
  items: PasteItem[],
  getPath: (file: File) => string,
): PasteItem[] {
  return items.map((it): PasteItem => {
    if (it.kind !== 'file') return it
    const p = getPath(it.file)
    return p ? { kind: 'path', path: p } : it
  })
}
