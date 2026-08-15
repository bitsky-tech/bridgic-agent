/**
 * Tests for task-file-guard.ts — the fs:writeFile path allowlist. Confirms it
 * only accepts `<...>/.work/.build/task.md` under ~/.bridgic and rejects escapes,
 * wrong filenames, and traversal.
 */
import { describe, it, expect } from 'bun:test'
import { isAllowedTaskFileWrite } from '../task-file-guard'

const ROOT = '/Users/me/.bridgic'

describe('isAllowedTaskFileWrite', () => {
  it('accepts a session .work/.build/task.md under the bridgic root', () => {
    expect(isAllowedTaskFileWrite(`${ROOT}/AmphiAgent/sessions/s1/.work/.build/task.md`, ROOT)).toBe(true)
  })

  it('rejects paths outside the bridgic root', () => {
    expect(isAllowedTaskFileWrite('/etc/passwd', ROOT)).toBe(false)
    expect(isAllowedTaskFileWrite('/Users/me/Desktop/x/.work/.build/task.md', ROOT)).toBe(false)
  })

  it('rejects traversal that climbs out of the root', () => {
    expect(isAllowedTaskFileWrite(`${ROOT}/../evil/.work/.build/task.md`, ROOT)).toBe(false)
  })

  it('rejects a wrong filename or wrong parent dir', () => {
    expect(isAllowedTaskFileWrite(`${ROOT}/s1/.work/secrets.md`, ROOT)).toBe(false)
    expect(isAllowedTaskFileWrite(`${ROOT}/s1/notwork/task.md`, ROOT)).toBe(false)
    expect(isAllowedTaskFileWrite(`${ROOT}/s1/notwork/.build/task.md`, ROOT)).toBe(false)
  })

  it('rejects relative / non-absolute input', () => {
    expect(isAllowedTaskFileWrite('.work/.build/task.md', ROOT)).toBe(false)
  })
})
