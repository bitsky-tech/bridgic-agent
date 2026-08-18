import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { daemonLogCandidates, selectDaemonLog } from '../daemon-log-path'

const HOME = path.join(path.sep, 'Users', 'tester')
const RUNTIME_DIR = path.join(HOME, '.bridgic', 'AmphiAgent')
const SERVER_LOG = path.join(RUNTIME_DIR, 'server.log')
const STDERR_LOG = path.join(RUNTIME_DIR, 'daemon.stderr.log')
const STDOUT_LOG = path.join(RUNTIME_DIR, 'daemon.stdout.log')
const RUNTIME_JSON = path.join(RUNTIME_DIR, 'runtime.json')

/** 用一张「路径 → mtime」表模拟磁盘；不在表里即不存在。 */
function disk(files: Record<string, number>) {
  return {
    exists: (candidate: string) => candidate in files,
    modifiedAt: (candidate: string) => files[candidate] ?? 0,
  }
}

describe('daemonLogCandidates', () => {
  it('daemon 上报的 log_file 排第一', () => {
    const candidates = daemonLogCandidates(
      { logFile: SERVER_LOG, runtimeFile: RUNTIME_JSON },
      'darwin',
      HOME,
    )
    expect(candidates[0]).toBe(SERVER_LOG)
  })

  it('没有 endpoint（daemon 未运行）时按约定目录猜测，含两个崩溃兜底文件', () => {
    expect(daemonLogCandidates({}, 'linux', HOME)).toEqual([
      SERVER_LOG,
      STDERR_LOG,
      STDOUT_LOG,
    ])
  })

  it('崩溃兜底同时覆盖 stdout —— launchd plist 配了两个流', () => {
    // 只有 stderr 在链里的话，输出走 stdout 的崩溃（裸 print、PyInstaller
    // 引导信息）会让「打开日志」报找不到，而证据就在同目录。
    const candidates = daemonLogCandidates({ runtimeFile: RUNTIME_JSON }, 'linux', HOME)
    expect(candidates).toContain(STDOUT_LOG)
    expect(candidates).toContain(STDERR_LOG)
  })

  it('旧版 daemon（无 log_file）用 runtimeFile 同目录猜测', () => {
    const elsewhere = path.join(path.sep, 'custom', 'dir')
    const candidates = daemonLogCandidates(
      { runtimeFile: path.join(elsewhere, 'runtime.json') },
      'linux',
      HOME,
    )
    expect(candidates[0]).toBe(path.join(elsewhere, 'server.log'))
    expect(candidates).toContain(SERVER_LOG)
  })

  it('macOS 追加旧版 launchd 位置作为末位回退，其他平台没有', () => {
    const legacy = path.join(HOME, 'Library', 'Logs', 'Amphi', 'daemon.stderr.log')
    expect(daemonLogCandidates({}, 'darwin', HOME)).toContain(legacy)
    expect(daemonLogCandidates({}, 'win32', HOME)).not.toContain(legacy)
  })

  it('重复候选被去重', () => {
    const candidates = daemonLogCandidates(
      { logFile: SERVER_LOG, runtimeFile: RUNTIME_JSON },
      'linux',
      HOME,
    )
    expect(candidates.filter((candidate) => candidate === SERVER_LOG)).toHaveLength(1)
  })
})

describe('selectDaemonLog', () => {
  const candidates = daemonLogCandidates(
    { logFile: SERVER_LOG, runtimeFile: RUNTIME_JSON },
    'linux',
    HOME,
  )

  it('全都不存在时返回 null，由调用方报出尝试过的路径', () => {
    expect(selectDaemonLog(candidates, disk({}), SERVER_LOG)).toBeNull()
  })

  it('daemon 亲口上报且文件存在时直接采用，不比 mtime', () => {
    // 上报的 server.log 是活的那份，哪怕兜底文件更新（另一个 daemon 实例）。
    const chosen = selectDaemonLog(
      candidates,
      disk({ [SERVER_LOG]: 100, [STDERR_LOG]: 999 }),
      SERVER_LOG,
    )
    expect(chosen).toBe(SERVER_LOG)
  })

  it('daemon 未上报时取最新的一个：过期 server.log 不再遮住今天的崩溃', () => {
    // 昨天跑成功过 → server.log 一直在；今天启动时在 import 阶段就死了，
    // traceback 只在 daemon.stderr.log 里。取「第一个存在的」会打开昨天的日志。
    const guesses = daemonLogCandidates({ runtimeFile: RUNTIME_JSON }, 'linux', HOME)
    expect(guesses.indexOf(SERVER_LOG)).toBeLessThan(guesses.indexOf(STDERR_LOG))
    const chosen = selectDaemonLog(guesses, disk({ [SERVER_LOG]: 100, [STDERR_LOG]: 500 }))
    expect(chosen).toBe(STDERR_LOG)
  })

  it('上报的路径不存在时（日志降级）退回最新的兜底文件', () => {
    const chosen = selectDaemonLog(
      candidates,
      disk({ [STDOUT_LOG]: 300, [STDERR_LOG]: 700 }),
      SERVER_LOG,
    )
    expect(chosen).toBe(STDERR_LOG)
  })
})
