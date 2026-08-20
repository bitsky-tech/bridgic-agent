import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { longestPackagedPath } from '../check-payload-paths'

describe('longestPackagedPath', () => {
  it('file-type extraResources entries (LICENSE/NOTICE) do not crash walk and are measured', () => {
    // `from: resources/LICENSE` in electron-builder.yml names a file, not a
    // directory; walk used to readdir the root outright, and the ENOTDIR
    // crashed the whole dist build at the check step.
    const dir = mkdtempSync(join(tmpdir(), 'payload-'))
    writeFileSync(join(dir, 'LICENSE'), 'x')
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'amphi'), 'x')

    const { longest, skipped } = longestPackagedPath(dir)

    expect(longest).not.toBeNull()
    // A file entry counts as one measured file, not "present but empty".
    expect(skipped.some((s) => s.startsWith('LICENSE'))).toBe(false)
  })
})
