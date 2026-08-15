/**
 * The **single** implementation of per-session JSON blob persistence: composer
 * drafts, staged spec comments, and sent-input history all use it.
 *
 * The shared contract of this kind of store:
 *   - Written frequently, so each gets its own file and is **not** merged into
 *     gui-settings.json — that would make every keystroke flush fire a
 *     settings-changed broadcast and refresh every settings consumer.
 *   - The map's value shape is **opaque** to main (the renderer holds
 *     `Segment[]` / `PendingComment[]` etc.); main only reads and writes JSON.
 *   - Reads **never throw**: missing / corrupted / non-object → `{}`, so the
 *     renderer can always start from an empty state.
 *   - Writes are atomic (`*.tmp` + rename); a crash mid-write can only leave
 *     the old or the new complete file behind, never half-broken JSON.
 *
 * Pure plus path-injectable, so it can be unit-tested without Electron
 * (isomorphic to `python-client/runtime-file.ts`). Callers (handlers/*) are
 * responsible for resolving the filename constants in app-meta into absolute
 * paths.
 *
 * History: drafts-file.ts and spec-comments-file.ts used to be two verbatim
 * duplicate implementations (the latter's comments literally said "isomorphic
 * to drafts-file.ts"), and only the former had tests. After merging into this
 * one file, all three blobs share the same implementation and the same tests.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { mainLog } from './logger'

/** sessionId → a value opaque to main (the value's shape belongs to the renderer). */
export type JsonBlobMap = Record<string, unknown>

/**
 * Read and parse a blob file. Returns `{}` when the file is missing,
 * unreadable, malformed, or not a plain object. **Never throws** — corrupted
 * persistence must not block app startup.
 *
 * @param filePath - Absolute path of the blob
 * @param label - The blob's name for logging (e.g. 'drafts'), used to tell which store went wrong
 */
export function readJsonBlob(filePath: string, label: string): JsonBlobMap {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
    // Arrays must be rejected too: JSON.parse('[]') is an object, but under map semantics it is dirty data.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as JsonBlobMap
  } catch (err) {
    // ENOENT is the normal path on first launch and doesn't warrant a warning.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') mainLog.warn(`[${label}] read failed; using empty`, err)
    return {}
  }
}

/**
 * Atomically write the whole map (`*.tmp` + rename). mode 0o600 — these blobs
 * may contain anything the user pasted into an input box.
 */
export function writeJsonBlob(map: JsonBlobMap, filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(map), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, filePath)
}
