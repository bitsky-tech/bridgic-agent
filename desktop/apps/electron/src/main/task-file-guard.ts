/**
 * Pure function: validate the target path of fs:writeFile. Only
 * `<...>/.work/.build/task.md` may be written, and it must sit under the
 * bridgic home directory (~/.bridgic), preventing the renderer from using that
 * IPC to write arbitrary files out of bounds.
 *
 * Pure logic (does not import electron) so it can be unit-tested with
 * bun:test; the home directory is injected by the handler.
 */
import path from 'node:path'
import { SESSION_TASK_FILE_REL } from '../shared/app-meta'

const EXPECTED_SUFFIX = path.normalize(SESSION_TASK_FILE_REL)

/**
 * @param absPath - The target absolute path passed in by the renderer
 * @param bridgicRoot - The root writes are allowed under (`~/.bridgic`), passed in by the handler via paths::bridgicHomeDir()
 * @returns Whether the write is allowed
 */
export function isAllowedTaskFileWrite(absPath: string, bridgicRoot: string): boolean {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return false
  const norm = path.normalize(absPath)
  // Must land inside ~/.bridgic/ (rel must not escape upwards, nor be another absolute path).
  const rel = path.relative(path.normalize(bridgicRoot), norm)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
  return norm.endsWith(`${path.sep}${EXPECTED_SUFFIX}`)
}
