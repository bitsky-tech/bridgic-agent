import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { daemonLogCandidates } from '../daemon-log-path'

const HOME = path.join(path.sep, 'Users', 'tester')
const RUNTIME_DIR = path.join(HOME, '.bridgic', 'AmphiAgent')

describe('daemonLogCandidates', () => {
  it('daemon 上报的 log_file 永远排第一', () => {
    const reported = path.join(RUNTIME_DIR, 'server.log')
    const candidates = daemonLogCandidates(
      { logFile: reported, runtimeFile: path.join(RUNTIME_DIR, 'runtime.json') },
      'darwin',
      HOME,
    )
    expect(candidates[0]).toBe(reported)
  })

  it('没有 endpoint（daemon 未运行）时按约定目录猜测并包含崩溃兜底文件', () => {
    const candidates = daemonLogCandidates({}, 'linux', HOME)
    expect(candidates).toEqual([
      path.join(RUNTIME_DIR, 'server.log'),
      path.join(RUNTIME_DIR, 'daemon.stderr.log'),
    ])
  })

  it('旧版 daemon（无 log_file）用 runtimeFile 同目录猜测', () => {
    const elsewhere = path.join(path.sep, 'custom', 'dir')
    const candidates = daemonLogCandidates(
      { runtimeFile: path.join(elsewhere, 'runtime.json') },
      'linux',
      HOME,
    )
    expect(candidates[0]).toBe(path.join(elsewhere, 'server.log'))
    expect(candidates).toContain(path.join(RUNTIME_DIR, 'server.log'))
  })

  it('macOS 上追加旧版 launchd 位置作为末位回退，其他平台没有', () => {
    const legacy = path.join(HOME, 'Library', 'Logs', 'Amphi', 'daemon.stderr.log')
    const mac = daemonLogCandidates({}, 'darwin', HOME)
    expect(mac[mac.length - 1]).toBe(legacy)
    expect(daemonLogCandidates({}, 'win32', HOME)).not.toContain(legacy)
  })

  it('重复候选被去重（runtimeFile 与默认目录相同时）', () => {
    const reported = path.join(RUNTIME_DIR, 'server.log')
    const candidates = daemonLogCandidates(
      { logFile: reported, runtimeFile: path.join(RUNTIME_DIR, 'runtime.json') },
      'linux',
      HOME,
    )
    expect(candidates.filter((candidate) => candidate === reported)).toHaveLength(1)
  })
})
