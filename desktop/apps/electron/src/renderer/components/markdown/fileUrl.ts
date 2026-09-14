/**
 * Resolves `file://` links in markdown prose into local file targets for the shared file-open router.
 *
 * Invariants: only the `file:` protocol is accepted; the returned `path` is already decoded (%20 etc.) and `name`
 * is its basename. Any non-file: protocol / malformed URL / decoding failure returns null, and the caller uses that
 * to decide whether to treat the link as an openable local file.
 *
 * Non-obvious dependency: it reuses the FileOpenTarget shape from `atoms/fileOpen`, so the parse result can be fed directly to
 * requestFileOpenAtom (DOCX → Word; other files → confirmed system open).
 */
import type { FileOpenTarget } from '@/atoms/fileOpen'

/**
 * Parse a `file://` URL into a local file target; returns null for a non-file: protocol, a malformed URL, or a decoding failure.
 *
 * `file:///Users/x/a.txt` → `{ path: '/Users/x/a.txt', name: 'a.txt' }`.
 * For the Windows drive-letter form `file:///C:/x`, the pathname's leading `/` is dropped (→ `C:/x`).
 */
export function fileUrlToTarget(href: string): FileOpenTarget | null {
  try {
    const url = new URL(href)
    if (url.protocol !== 'file:') return null
    let path = decodeURIComponent(url.pathname)
    // UNC: file://server/share/a.txt -> \\server\share\a.txt. A non-local host is the
    // URL representation of a Windows network path; preserving it is essential because
    // pathname alone would silently turn it into the unrelated local path /share/a.txt.
    if (url.hostname && url.hostname !== 'localhost') {
      path = `\\\\${url.hostname}${path.replaceAll('/', '\\')}`
    }
    // Windows: the pathname of file:///C:/… is /C:/… → drop the leading slash to restore the drive-letter path.
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1)
    if (!path) return null
    const name = path.split(/[\\/]/).pop() || path
    return { path, name }
  } catch {
    return null
  }
}
