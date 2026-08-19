/**
 * loggedHandle 与日志 transport 之间的契约：IPC 参数只被序列化一次。
 *
 * 此前 loggedHandle 先用一套限额把参数走一遍，transport 的 format 回调再走
 * 一遍，于是第一遍留下的截断标记被第二遍当成普通元素二次截断——25 元素的
 * 数组在 main.log 里显示成 "+1 more"，700 字符的字符串被记成 506。旧测试
 * 只断言中间那一层，所以全绿而每一行真实日志都是错的。
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { toLogLine } from '../../log-serialize'
import { electronModuleMock, loggerModuleMock, testIpcHandlers } from '../../__tests__/electron-module-mock'

mock.module('electron', () => electronModuleMock)
// 相对本测试文件解析：logged-handle 引的 '../logger' 落在 main/ 下。
mock.module('../../logger', () => loggerModuleMock)

const { loggedHandle } = await import('../logged-handle')

/** 捕获 handlerLog.debug 收到的入参行，返回其经 transport 渲染后的结果。 */
async function logLineFor(channel: string, args: unknown[]): Promise<unknown[]> {
  let captured: unknown[] = []
  const original = loggerModuleMock.handlerLog.debug
  loggerModuleMock.handlerLog.debug = ((...data: unknown[]) => {
    if (typeof data[0] === 'string' && data[0].startsWith('→')) captured = data
  }) as typeof original
  try {
    loggedHandle(channel, () => 'ok')
    await testIpcHandlers.get(channel)?.({} as never, ...args)
  } finally {
    loggerModuleMock.handlerLog.debug = original
  }
  // transport 真正写盘的那一行。
  const line = JSON.parse(toLogLine({ date: new Date(0), level: 'debug', data: captured }))
  return line.message as unknown[]
}

describe('IPC 参数只序列化一次', () => {
  beforeEach(() => {
    testIpcHandlers.clear()
  })

  it('超长数组的余量标记是真实余量，不被二次截断', async () => {
    const [, args] = await logLineFor('test:array', [Array.from({ length: 25 }, (_, i) => i)])
    const arr = (args as unknown[][])[0] ?? []
    expect(arr).toHaveLength(11)
    expect(arr[10]).toBe('…(+15 more)')
  })

  it('超长字符串标注的是原始长度，不是第一遍截断后的长度', async () => {
    const [, args] = await logLineFor('test:string', ['a'.repeat(700)])
    expect((args as string[])[0]).toContain('…(700)')
  })

  it('对象余量标记同样只记一次', async () => {
    const obj: Record<string, number> = {}
    for (let i = 0; i < 30; i += 1) obj[`k${i}`] = i
    const [, args] = await logLineFor('test:object', [obj])
    expect((args as Record<string, unknown>[])[0]?.['…']).toBe('+10 more')
  })

  it('transformLogArgs 的结果同样原样交给 transport', async () => {
    let captured: unknown[] = []
    const original = loggerModuleMock.handlerLog.debug
    loggerModuleMock.handlerLog.debug = ((...data: unknown[]) => {
      if (typeof data[0] === 'string' && data[0].startsWith('→')) captured = data
    }) as typeof original
    try {
      loggedHandle('test:transform', () => 'ok', {
        transformLogArgs: () => ({ token: '[redacted]' }),
      })
      await testIpcHandlers.get('test:transform')?.({} as never, 'secret')
    } finally {
      loggerModuleMock.handlerLog.debug = original
    }
    expect(captured[1]).toEqual({ token: '[redacted]' })
  })
})
