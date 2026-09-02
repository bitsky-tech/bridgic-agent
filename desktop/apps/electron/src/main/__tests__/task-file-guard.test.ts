/**
 * Tests for task-file-guard.ts — the fs:writeFile path allowlist. Confirms it
 * only accepts `<...>/.work/.build/task.md` under ~/.bridgic and rejects escapes,
 * wrong filenames, and traversal.
 */
import { describe, it, expect } from 'bun:test'
import { isAllowedTaskFileWrite } from '../task-file-guard'

const ROOT = '/Users/me/.bridgic'

describe('isAllowedTaskFileWrite', () => {
  it('accepts only a session .work/.build/task.md under the bridgic root', () => {
    expect(isAllowedTaskFileWrite(`${ROOT}/AmphiAgent/sessions/s1/.work/.build/task.md`, ROOT)).toBe(true)

    const rejected = [
      '/etc/passwd',
      '/Users/me/Desktop/x/.work/.build/task.md',
      `${ROOT}/../evil/.work/.build/task.md`,
      `${ROOT}/s1/.work/secrets.md`,
      `${ROOT}/s1/notwork/task.md`,
      `${ROOT}/s1/notwork/.build/task.md`,
      '.work/.build/task.md',
    ]
    for (const path of rejected) {
      expect(isAllowedTaskFileWrite(path, ROOT)).toBe(false)
    }
  })
})
