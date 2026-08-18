import { describe, expect, it } from 'bun:test'
import vm from 'node:vm'
import {
  LOG_LIMITS,
  safeStringify,
  toLogLine,
  toLogText,
  toSerializable,
} from '../log-serialize'

/** 复刻 execSync 超时抛出的 Error 形状：循环引用 + 捕获到的子进程输出。 */
function execSyncTimeoutError(stdout = 'partial output'): Error {
  const err = new Error('spawnSync /bin/zsh ETIMEDOUT') as Error & Record<string, unknown>
  err.errno = -110
  err.code = 'ETIMEDOUT'
  err.syscall = 'spawnSync /bin/zsh'
  err.error = err
  err.stdout = stdout
  err.stderr = ''
  return err
}

function line(...data: unknown[]): string {
  return toLogLine({ date: new Date('2026-08-18T00:00:00Z'), level: 'error', scope: 'main', data })
}

describe('toLogLine 永不抛错、永不丢行', () => {
  const hostile: Array<[string, () => unknown]> = [
    ['循环引用的 execSync 错误', () => execSyncTimeoutError()],
    [
      '取值即抛错的 getter',
      () => ({
        get boom() {
          throw new Error('getter exploded')
        },
      }),
    ],
    ['非法 Date', () => new Date('nonsense')],
    [
      '已撤销的 Proxy',
      () => {
        const revocable = Proxy.revocable({}, {})
        revocable.revoke()
        return revocable.proxy
      },
    ],
    ['键无法转为原始值的 Map', () => new Map([[Object.create(null) as object, 1]])],
    ['互相引用的两个对象', () => {
      const a: Record<string, unknown> = {}
      const b: Record<string, unknown> = { a }
      a.b = b
      return a
    }],
    ['无原型对象', () => Object.create(null)],
    ['BigInt / Symbol / 函数', () => ({ big: 1n, sym: Symbol('s'), fn: () => undefined })],
  ]

  for (const [name, make] of hostile) {
    it(`${name}：产出合法 JSON 行`, () => {
      let rendered = ''
      expect(() => {
        rendered = line('[probe]', make())
      }).not.toThrow()
      const parsed = JSON.parse(rendered) as { message: unknown[]; timestamp: string }
      expect(parsed.message[0]).toBe('[probe]')
      expect(parsed.timestamp).toBe('2026-08-18T00:00:00.000Z')
    })
  }

  it('非法 Date 作为时间戳时降级而不是丢行', () => {
    const rendered = toLogLine({
      date: new Date('nonsense'),
      level: 'warn',
      scope: 'main',
      data: ['still recorded'],
    })
    const parsed = JSON.parse(rendered) as { timestamp: string; message: unknown[] }
    expect(parsed.timestamp).toBe('[invalid date]')
    expect(parsed.message[0]).toBe('still recorded')
  })
})

describe('不把子进程捕获的输出写进日志', () => {
  it('execSync 超时错误里的 stdout 只留长度，不留内容', () => {
    // shell-env.ts 跑的是 `zsh -l -i -c 'echo __ENV_START__ && env'`：超时后
    // Node 把已捕获的 env dump 挂在错误上，其中含用户的 API key。
    const secret = 'OPENAI_API_KEY=sk-super-secret-value'
    const rendered = line('[shell-env] load failed', execSyncTimeoutError(`PATH=/usr/bin\n${secret}\n`))
    expect(rendered).not.toContain('sk-super-secret-value')
    expect(rendered).not.toContain('OPENAI_API_KEY')
    expect(rendered).toContain('[stdout 51 chars]')
    // 诊断价值仍在：错误类型、错误码、调用点都保留。
    expect(rendered).toContain('ETIMEDOUT')
    expect(rendered).toContain('spawnSync /bin/zsh')
  })

  it('stderr 与 output 同样只留摘要', () => {
    const err = new Error('boom') as Error & Record<string, unknown>
    err.stderr = 'secret-in-stderr'
    err.output = [null, 'secret-in-output', 'more']
    const rendered = line(err)
    expect(rendered).not.toContain('secret-in-stderr')
    expect(rendered).not.toContain('secret-in-output')
    expect(rendered).toContain('[stderr 16 chars]')
    expect(rendered).toContain('[output 3 entries]')
  })
})

describe('Error 序列化', () => {
  it('保留 name/message/stack（而不是 {}）', () => {
    const out = toSerializable(new Error('boom')) as Record<string, unknown>
    expect(out.name).toBe('Error')
    expect(out.message).toBe('boom')
    expect(typeof out.stack).toBe('string')
  })

  it('循环引用标记为 [circular]', () => {
    const out = toSerializable(execSyncTimeoutError()) as Record<string, unknown>
    expect(out.code).toBe('ETIMEDOUT')
    expect(out.error).toBe('[circular]')
  })

  it('AggregateError 的 errors 子错误不丢失（fetch 失败的主力形态）', () => {
    const out = toSerializable(
      new AggregateError([new Error('ECONNREFUSED ::1'), new Error('ECONNREFUSED 127.0.0.1')], 'fetch failed'),
    ) as { errors: Array<{ message: string }> }
    expect(out.errors).toHaveLength(2)
    expect(out.errors[0]?.message).toContain('ECONNREFUSED ::1')
  })

  it('cause 链被递归序列化', () => {
    const out = toSerializable(new Error('wrapper', { cause: new Error('root cause') })) as {
      cause: Record<string, unknown>
    }
    expect(out.cause.message).toBe('root cause')
  })

  it('跨 realm 的 Error 也按 Error 处理（instanceof 判不出来）', () => {
    // Electron 主进程里 utilityProcess / vm 上下文抛出的错误就是这个形状。
    const foreign = vm.runInNewContext('new TypeError("from another realm")') as Error
    expect(foreign instanceof Error).toBe(false)
    const out = toSerializable(foreign) as Record<string, unknown>
    expect(out.name).toBe('TypeError')
    expect(out.message).toBe('from another realm')
  })
})

describe('体积与耗时上限', () => {
  it('Buffer 记为字节数摘要，不逐字节展开', () => {
    const out = toSerializable({ body: Buffer.from('hello world') }) as Record<string, string>
    expect(out.body).toBe('[Buffer 11 bytes]')
    expect(safeStringify(toSerializable({ big: Buffer.alloc(200_000) })).length).toBeLessThan(100)
  })

  it('超长字符串截断并标注原长', () => {
    const out = toSerializable('x'.repeat(700)) as string
    expect(out).toContain('…(700)')
    expect(out.length).toBeLessThan(600)
  })

  it('数组与对象超限时留下余量标记', () => {
    const arr = toSerializable(Array.from({ length: 25 }, (_, i) => i)) as unknown[]
    expect(arr).toHaveLength(LOG_LIMITS.maxArrayItems + 1)
    expect(arr[LOG_LIMITS.maxArrayItems]).toBe('…(+15 more)')

    const wide: Record<string, number> = {}
    for (let i = 0; i < 30; i += 1) wide[`k${i}`] = i
    const obj = toSerializable(wide) as Record<string, unknown>
    expect(obj['…']).toBe('+10 more')
  })

  it('共享子图不会指数级展开：节点预算封顶且耗时可控', () => {
    // 每层 12 个键指向同一个子对象，深 6 层。没有预算时是 12^6 个节点。
    let shared: Record<string, unknown> = { leaf: true }
    for (let level = 0; level < 6; level += 1) {
      const next: Record<string, unknown> = {}
      for (let key = 0; key < 12; key += 1) next[`k${key}`] = shared
      shared = next
    }
    const started = performance.now()
    const rendered = safeStringify(toSerializable(shared))
    expect(performance.now() - started).toBeLessThan(200)
    expect(rendered).toContain('[truncated]')
  })

  it('深度超限截断为 …', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 10; i += 1) deep = { next: deep }
    const rendered = safeStringify(toSerializable(deep))
    expect(rendered).toContain('…')
    expect(rendered).not.toContain('leaf')
  })
})

describe('对象键的边界情况', () => {
  it('自有 __proto__ 键被记录而不是静默丢失', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"secret":1},"keep":2}')
    const out = toSerializable(parsed) as Record<string, unknown>
    expect(out.keep).toBe(2)
    expect(out['__proto__']).toEqual({ secret: 1 })
  })

  it('名为 constructor/toString 的自有属性不被原型链误判为已存在', () => {
    const err = new Error('boom') as unknown as Record<string, unknown>
    err['constructor'] = 'shadowed'
    err['toString'] = 'also shadowed'
    const out = toSerializable(err) as Record<string, unknown>
    expect(out['constructor']).toBe('shadowed')
    expect(out['toString']).toBe('also shadowed')
  })

  it('取值抛错的 getter 只降级该字段', () => {
    const out = toSerializable({
      ok: 'kept',
      get boom() {
        throw new Error('getter exploded')
      },
    }) as Record<string, string>
    expect(out.ok).toBe('kept')
    expect(out.boom).toContain('getter threw')
  })
})

describe('toLogText（终端 transport）', () => {
  it('字符串原样输出，对象走安全序列化', () => {
    expect(toLogText('plain')).toBe('plain')
    expect(toLogText(execSyncTimeoutError())).toContain('ETIMEDOUT')
  })
})

describe('safeStringify', () => {
  it('正常对象与 JSON.stringify 一致', () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}')
  })

  it('对会抛错的输入降级为 serializationError 行', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const parsed = JSON.parse(safeStringify(cyclic)) as { serializationError: string }
    expect(parsed.serializationError.length).toBeGreaterThan(0)
  })
})
