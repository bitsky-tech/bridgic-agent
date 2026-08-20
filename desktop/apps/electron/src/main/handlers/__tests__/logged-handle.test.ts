/**
 * The contract between loggedHandle and the log transport: IPC arguments are
 * serialized exactly once.
 *
 * loggedHandle used to pre-walk its arguments under one set of limits and the
 * transport's format callback walked the result again, re-truncating the
 * first pass's truncation markers as ordinary elements — a 25-element array
 * showed up in main.log as "+1 more" and a 700-char string was recorded as
 * 506. The old tests asserted on the middle layer only, so they stayed green
 * while every real log line was wrong.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { toLogLine } from '../../log-serialize'
import { electronModuleMock, loggerModuleMock, testIpcHandlers } from '../../__tests__/electron-module-mock'

mock.module('electron', () => electronModuleMock)
// Resolved relative to THIS test file: the '../logger' that logged-handle
// imports lives under main/.
mock.module('../../logger', () => loggerModuleMock)

const { loggedHandle } = await import('../logged-handle')

/** Capture the argument line handlerLog.debug received and return it as the transport renders it. */
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
  // The exact line the transport writes to disk.
  const line = JSON.parse(toLogLine({ date: new Date(0), level: 'debug', data: captured }))
  return line.message as unknown[]
}

describe('IPC arguments are serialized exactly once', () => {
  beforeEach(() => {
    testIpcHandlers.clear()
  })

  it('an oversized array keeps its real remainder marker, never re-truncated', async () => {
    const [, args] = await logLineFor('test:array', [Array.from({ length: 25 }, (_, i) => i)])
    const arr = (args as unknown[][])[0] ?? []
    expect(arr).toHaveLength(11)
    expect(arr[10]).toBe('…(+15 more)')
  })

  it('an oversized string reports its original length, not the once-truncated one', async () => {
    const [, args] = await logLineFor('test:string', ['a'.repeat(700)])
    expect((args as string[])[0]).toContain('…(700)')
  })

  it('object remainder markers are likewise recorded only once', async () => {
    const obj: Record<string, number> = {}
    for (let i = 0; i < 30; i += 1) obj[`k${i}`] = i
    const [, args] = await logLineFor('test:object', [obj])
    expect((args as Record<string, unknown>[])[0]?.['…']).toBe('+10 more')
  })

  it('transformLogArgs output reaches the transport untouched as well', async () => {
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
