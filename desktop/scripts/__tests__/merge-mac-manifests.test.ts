/**
 * merge-mac-manifests —— 把每个架构各自的 latest-mac.yml 合成一份多架构 feed。
 *
 * 这里验的是「合错了会让某个架构永远更新不了」的那几种形状:
 *  - 两个架构都在 files 里(Intel 平权的核心断言);
 *  - 版本不一致时必须失败,而不是挑一个;
 *  - 结果里必须有 arm64,否则主流平台反而没得更新;
 *  - 遗留的 path/sha512 指向 arm64(老客户端只认这两个字段)。
 *
 * 客户端侧的选择逻辑不在这里测——那是 electron-updater 的实现
 * (MacUpdater.js 按 url 是否含 `arm64` 分流),本测试只保证喂给它的清单形状对。
 */
import { describe, expect, it } from 'bun:test'
import { isArm64Entry, mergeMacManifests, type MacManifest } from '../merge-mac-manifests'

/** 取自真机产出的 0.1.9 清单,只是把 sha512 截短。 */
const ARM64: MacManifest = {
  version: '0.1.9',
  files: [{ url: 'Bridgic-Agent-0.1.9-arm64.zip', sha512: 'AAAAarm64==', size: 232493718 }],
  path: 'Bridgic-Agent-0.1.9-arm64.zip',
  sha512: 'AAAAarm64==',
  releaseDate: '2026-08-11T15:45:00.000Z',
}

const X64: MacManifest = {
  version: '0.1.9',
  files: [{ url: 'Bridgic-Agent-0.1.9-x64.zip', sha512: 'BBBBx64==', size: 240000000 }],
  path: 'Bridgic-Agent-0.1.9-x64.zip',
  sha512: 'BBBBx64==',
  releaseDate: '2026-08-11T16:10:00.000Z',
}

describe('isArm64Entry', () => {
  it('mirrors the client-side substring test', () => {
    // MacUpdater 就是这么判的:看 url 里有没有 `arm64`。
    expect(isArm64Entry(ARM64.files[0]!)).toBe(true)
    expect(isArm64Entry(X64.files[0]!)).toBe(false)
  })
})

describe('mergeMacManifests', () => {
  it('keeps both architectures so each machine can find its own build', () => {
    const merged = mergeMacManifests([ARM64, X64])

    expect(merged.files).toHaveLength(2)
    expect(merged.files.filter(isArm64Entry)).toHaveLength(1)
    // Intel 端靠「滤掉 arm64 之后还剩东西」才能更新——这条为空就是静默失败。
    expect(merged.files.filter((f) => !isArm64Entry(f))).toHaveLength(1)
  })

  it('is order-independent', () => {
    const a = mergeMacManifests([ARM64, X64])
    const b = mergeMacManifests([X64, ARM64])
    expect(new Set(a.files.map((f) => f.url))).toEqual(new Set(b.files.map((f) => f.url)))
  })

  it('points legacy path/sha512 at arm64 even when x64 comes first', () => {
    // 老客户端不认 files,只读这两个字段(Provider.js::getFileList 的兜底)。
    const merged = mergeMacManifests([X64, ARM64])
    expect(merged.path).toBe('Bridgic-Agent-0.1.9-arm64.zip')
    expect(merged.sha512).toBe('AAAAarm64==')
  })

  it('refuses to merge builds of different versions', () => {
    // 版本不一致意味着两个 job build 的不是同一个 commit;挑一个会让一半用户
    // 拿到 manifest 与后端对不上的包,那正是会卡死在版本门禁页的组合。
    expect(() => mergeMacManifests([ARM64, { ...X64, version: '0.2.0' }])).toThrow(/version mismatch/)
  })

  it('refuses a feed with no arm64 build', () => {
    expect(() => mergeMacManifests([X64])).toThrow(/no arm64 entry/)
  })

  it('drops duplicate urls', () => {
    const merged = mergeMacManifests([ARM64, ARM64, X64])
    expect(merged.files).toHaveLength(2)
  })

  it('takes the newest releaseDate so a retried job never moves the feed backwards', () => {
    expect(mergeMacManifests([ARM64, X64]).releaseDate).toBe('2026-08-11T16:10:00.000Z')
  })

  it('rejects an empty input list', () => {
    expect(() => mergeMacManifests([])).toThrow(/no manifests/)
  })
})
