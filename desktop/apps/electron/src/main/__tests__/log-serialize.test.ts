import { describe, expect, it } from 'bun:test'
import { safeStringify, toSerializable } from '../log-serialize'

/** 复刻 execSync 超时抛出的 Error 形状：err.error === err 的循环引用。 */
function execSyncTimeoutError(): Error {
  const err = new Error('spawnSync /bin/zsh ETIMEDOUT') as Error & Record<string, unknown>
  err.errno = -110
  err.code = 'ETIMEDOUT'
  err.syscall = 'spawnSync /bin/zsh'
  err.error = err
  err.stdout = 'partial output'
  err.stderr = ''
  return err
}

describe('toSerializable', () => {
  it('Error 序列化出 name/message/stack（而不是 {}）', () => {
    const out = toSerializable(new Error('boom')) as Record<string, unknown>
    expect(out.name).toBe('Error')
    expect(out.message).toBe('boom')
    expect(typeof out.stack).toBe('string')
    expect(JSON.stringify(out)).not.toBe('{}')
  })

  it('execSync 超时的循环引用 Error 不抛且标记 [circular]', () => {
    const out = toSerializable(execSyncTimeoutError()) as Record<string, unknown>
    expect(out.code).toBe('ETIMEDOUT')
    expect(out.error).toBe('[circular]')
    expect(out.stdout).toBe('partial output')
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('普通对象里的循环引用被替换而非抛错', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    const out = toSerializable(a) as Record<string, unknown>
    expect(out.name).toBe('a')
    expect(out.self).toBe('[circular]')
  })

  it('菱形引用（同一对象出现两次但无环）保留两份内容', () => {
    const shared = { value: 1 }
    const out = toSerializable({ left: shared, right: shared }) as {
      left: { value: number }
      right: { value: number }
    }
    expect(out.left.value).toBe(1)
    expect(out.right.value).toBe(1)
  })

  it('Error.cause 链被递归序列化', () => {
    const cause = new Error('root cause')
    const err = new Error('wrapper', { cause })
    const out = toSerializable(err) as { cause: Record<string, unknown> }
    expect(out.cause.message).toBe('root cause')
  })

  it('超过深度上限时截断为占位符', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 10; i++) deep = { next: deep }
    const text = JSON.stringify(toSerializable(deep))
    expect(text).toContain('[object]')
    expect(text).not.toContain('leaf')
  })

  it('基础类型与 null/undefined 直通', () => {
    expect(toSerializable('s')).toBe('s')
    expect(toSerializable(42)).toBe(42)
    expect(toSerializable(true)).toBe(true)
    expect(toSerializable(null)).toBe(null)
    expect(toSerializable(undefined)).toBe(undefined)
  })

  it('BigInt/函数/Symbol/Map/Set/Date 给出可 JSON 化的降级', () => {
    const out = toSerializable({
      big: 10n,
      fn: function named() {},
      sym: Symbol('x'),
      map: new Map([['k', 'v']]),
      set: new Set([1, 2]),
      date: new Date('2026-08-18T00:00:00Z'),
    }) as Record<string, unknown>
    expect(out.big).toBe('10n')
    expect(out.fn).toBe('[function named]')
    expect(out.sym).toBe('Symbol(x)')
    expect(out.map).toEqual({ k: 'v' })
    expect(out.set).toEqual([1, 2])
    expect(out.date).toBe('2026-08-18T00:00:00.000Z')
    expect(() => JSON.stringify(out)).not.toThrow()
  })
})

describe('safeStringify', () => {
  it('正常对象输出与 JSON.stringify 一致', () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}')
  })

  it('对 stringify 会抛错的输入降级为 serializationError 行而不是抛出', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const line = safeStringify(cyclic)
    const parsed = JSON.parse(line) as { serializationError: string }
    expect(parsed.serializationError.length).toBeGreaterThan(0)
  })

  it('日志封套（toSerializable 之后）在毒性输入下始终产出合法 JSON 行', () => {
    const nastyInputs: unknown[] = [
      execSyncTimeoutError(),
      (() => {
        const a: Record<string, unknown> = {}
        const b: Record<string, unknown> = { a }
        a.b = b
        return a
      })(),
      [1, undefined, null, 10n],
      new Map([[{}, new Set([Symbol('s')])]]),
      Object.create(null),
    ]
    for (const input of nastyInputs) {
      const line = safeStringify({
        timestamp: '2026-08-18T00:00:00.000Z',
        level: 'error',
        scope: 'main',
        message: [input].map(toSerializable),
      })
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})
