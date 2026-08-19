import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { longestPackagedPath } from '../check-payload-paths'

describe('longestPackagedPath', () => {
  it('文件型 extraResources 条目(LICENSE/NOTICE)不使 walk 崩溃,并计入测量', () => {
    // electron-builder.yml 里 `from: resources/LICENSE` 指向文件而非目录;
    // 此前 walk 对根节点直接 readdir,ENOTDIR 让整个 dist 构建在检查步骤崩掉。
    const dir = mkdtempSync(join(tmpdir(), 'payload-'))
    writeFileSync(join(dir, 'LICENSE'), 'x')
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'amphi'), 'x')

    const { longest, skipped } = longestPackagedPath(dir)

    expect(longest).not.toBeNull()
    // 文件条目本身被计为一个文件,不算 "present but empty"。
    expect(skipped.some((s) => s.startsWith('LICENSE'))).toBe(false)
  })
})
