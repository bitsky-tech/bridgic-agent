import { describe, expect, it } from 'bun:test'
import vm from 'node:vm'
import {
  LOG_LIMITS,
  safeStringify,
  toConsoleLine,
  toLogLine,
  toSerializable,
} from '../log-serialize'

/** Replica of the Error execSync raises on timeout: a cycle plus captured child-process output. */
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

describe('toLogLine never throws and never drops a line', () => {
  const hostile: Array<[string, () => unknown]> = [
    ['cyclic execSync error', () => execSyncTimeoutError()],
    [
      'getter that throws on read',
      () => ({
        get boom() {
          throw new Error('getter exploded')
        },
      }),
    ],
    ['invalid Date', () => new Date('nonsense')],
    [
      'revoked Proxy',
      () => {
        const revocable = Proxy.revocable({}, {})
        revocable.revoke()
        return revocable.proxy
      },
    ],
    ['Map whose key cannot become a primitive', () => new Map([[Object.create(null) as object, 1]])],
    ['two mutually referencing objects', () => {
      const a: Record<string, unknown> = {}
      const b: Record<string, unknown> = { a }
      a.b = b
      return a
    }],
    ['null-prototype object', () => Object.create(null)],
    ['BigInt / Symbol / function', () => ({ big: 1n, sym: Symbol('s'), fn: () => undefined })],
  ]

  for (const [name, make] of hostile) {
    it(`${name}: produces a valid JSON line`, () => {
      let rendered = ''
      expect(() => {
        rendered = line('[probe]', make())
      }).not.toThrow()
      const parsed = JSON.parse(rendered) as { message: unknown[]; timestamp: string }
      expect(parsed.message[0]).toBe('[probe]')
      expect(parsed.timestamp).toBe('2026-08-18T00:00:00.000Z')
    })
  }

  it('degrades an invalid Date timestamp instead of dropping the line', () => {
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

describe('captured child-process output never reaches the log', () => {
  it('keeps only the length of the stdout on an execSync timeout error', () => {
    // shell-env.ts runs `zsh -l -i -c 'echo __ENV_START__ && env'`: on timeout
    // Node attaches the captured env dump to the error, user API keys included.
    const secret = 'OPENAI_API_KEY=sk-super-secret-value'
    const rendered = line('[shell-env] load failed', execSyncTimeoutError(`PATH=/usr/bin\n${secret}\n`))
    expect(rendered).not.toContain('sk-super-secret-value')
    expect(rendered).not.toContain('OPENAI_API_KEY')
    expect(rendered).toContain('[stdout 51 chars]')
    // The diagnostic value survives: error type, code and call site all stay.
    expect(rendered).toContain('ETIMEDOUT')
    expect(rendered).toContain('spawnSync /bin/zsh')
  })

  it('stderr and output are summarized the same way', () => {
    const err = new Error('boom') as Error & Record<string, unknown>
    err.stderr = 'secret-in-stderr'
    err.output = [null, 'secret-in-output', 'more']
    const rendered = line(err)
    expect(rendered).not.toContain('secret-in-stderr')
    expect(rendered).not.toContain('secret-in-output')
    expect(rendered).toContain('[stderr 16 chars]')
    expect(rendered).toContain('[output 3 entries]')
  })

  it('summarizes stdout/stderr on plain result objects, not just on Errors', () => {
    // A successful spawnSync result carries the same keys without being an
    // Error; it used to be copied verbatim.
    const rendered = line('[shell-env] probe', {
      status: 0,
      stdout: 'OPENAI_API_KEY=sk-super-secret-value\n',
      stderr: '',
    })
    expect(rendered).not.toContain('sk-super-secret-value')
    expect(rendered).toContain('[stdout 37 chars]')
    expect(rendered).toContain('"status":0')
  })

  it('cuts the stderr hiding inside message on a non-timeout failure', () => {
    // On a non-zero exit Node folds stderr into the message itself:
    // `Command failed: <cmd>\n<stderr>` — invisible to any key-name check.
    const err = new Error(
      'Command failed: zsh -l -i -c \'env\'\nOPENAI_API_KEY=sk-super-secret-value\n',
    )
    const rendered = line(err)
    expect(rendered).not.toContain('sk-super-secret-value')
    expect(rendered).toContain('Command failed: zsh -l -i -c')
    expect(rendered).toContain('chars of output')
  })
})

describe('Error serialization', () => {
  it('keeps name/message/stack (instead of {})', () => {
    const out = toSerializable(new Error('boom')) as Record<string, unknown>
    expect(out.name).toBe('Error')
    expect(out.message).toBe('boom')
    expect(typeof out.stack).toBe('string')
  })

  it('marks cycles as [circular]', () => {
    const out = toSerializable(execSyncTimeoutError()) as Record<string, unknown>
    expect(out.code).toBe('ETIMEDOUT')
    expect(out.error).toBe('[circular]')
  })

  it('keeps AggregateError sub-errors (the main shape of a failed fetch)', () => {
    const out = toSerializable(
      new AggregateError([new Error('ECONNREFUSED ::1'), new Error('ECONNREFUSED 127.0.0.1')], 'fetch failed'),
    ) as { errors: Array<{ message: string }> }
    expect(out.errors).toHaveLength(2)
    expect(out.errors[0]?.message).toContain('ECONNREFUSED ::1')
  })

  it('serializes the cause chain recursively', () => {
    const out = toSerializable(new Error('wrapper', { cause: new Error('root cause') })) as {
      cause: Record<string, unknown>
    }
    expect(out.cause.message).toBe('root cause')
  })

  it('treats a cross-realm Error as an Error (instanceof cannot tell)', () => {
    // Errors thrown from utilityProcess / vm contexts in the Electron main
    // process arrive in exactly this shape.
    const foreign = vm.runInNewContext('new TypeError("from another realm")') as Error
    expect(foreign instanceof Error).toBe(false)
    const out = toSerializable(foreign) as Record<string, unknown>
    expect(out.name).toBe('TypeError')
    expect(out.message).toBe('from another realm')
  })
})

describe('size and time ceilings', () => {
  it('records a Buffer as a byte-count summary, never byte by byte', () => {
    const out = toSerializable({ body: Buffer.from('hello world') }) as Record<string, string>
    expect(out.body).toBe('[Buffer 11 bytes]')
    expect(safeStringify(toSerializable({ big: Buffer.alloc(200_000) })).length).toBeLessThan(100)
  })

  it('truncates long strings and appends the original length', () => {
    const out = toSerializable('x'.repeat(700)) as string
    expect(out).toContain('…(700)')
    expect(out.length).toBeLessThan(600)
  })

  it('leaves a remainder marker on oversized arrays and objects', () => {
    const arr = toSerializable(Array.from({ length: 25 }, (_, i) => i)) as unknown[]
    expect(arr).toHaveLength(LOG_LIMITS.maxArrayItems + 1)
    expect(arr[LOG_LIMITS.maxArrayItems]).toBe('…(+15 more)')

    const wide: Record<string, number> = {}
    for (let i = 0; i < 30; i += 1) wide[`k${i}`] = i
    const obj = toSerializable(wide) as Record<string, unknown>
    expect(obj['…']).toBe('+10 more')
  })

  it('shared subgraphs cannot expand exponentially: the node budget caps cost', () => {
    // 12 keys per level all pointing at one shared child, 6 levels deep —
    // 12^6 nodes without a budget.
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

  it('takes only the capped entries of a large Map/Set, never materializing it', () => {
    const big = new Map<number, number>()
    for (let i = 0; i < 50_000; i += 1) big.set(i, i)
    const out = toSerializable(big) as unknown[]
    expect(out).toHaveLength(LOG_LIMITS.maxArrayItems + 1)
    expect(out[LOG_LIMITS.maxArrayItems]).toBe(`…(+${50_000 - LOG_LIMITS.maxArrayItems} more)`)
    expect(out[0]).toEqual([0, 0])
  })

  it('does not invoke getters past the key cap for nothing', () => {
    let reads = 0
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 40; i += 1) {
      Object.defineProperty(wide, `k${i}`, {
        enumerable: true,
        get: () => {
          reads += 1
          return i
        },
      })
    }
    const out = toSerializable(wide) as Record<string, unknown>
    expect(reads).toBe(LOG_LIMITS.maxObjectKeys)
    expect(out['…']).toBe(`+${40 - LOG_LIMITS.maxObjectKeys} more`)
  })

  it('shares one node budget per log call, not one per argument', () => {
    // ~1600 nodes: one argument sits well inside the 5000 budget, four of
    // them together must exceed it.
    const fanout = (width: number, build: (i: number) => unknown): Record<string, unknown> =>
      Object.fromEntries(Array.from({ length: width }, (_, i) => [`k${i}`, build(i)]))
    const bulky = fanout(20, () => fanout(20, () => fanout(3, (i) => i)))

    expect(line(bulky)).not.toContain('[truncated]')
    expect(line(bulky, bulky, bulky, bulky)).toContain('[truncated]')
  })

  it('truncates past the depth limit to …', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 10; i += 1) deep = { next: deep }
    const rendered = safeStringify(toSerializable(deep))
    expect(rendered).toContain('…')
    expect(rendered).not.toContain('leaf')
  })
})

describe('object-key edge cases', () => {
  it('records an own __proto__ key instead of silently dropping it', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"secret":1},"keep":2}')
    const out = toSerializable(parsed) as Record<string, unknown>
    expect(out.keep).toBe(2)
    expect(out['__proto__']).toEqual({ secret: 1 })
  })

  it('own constructor/toString properties are not mistaken for prototype ones', () => {
    const err = new Error('boom') as unknown as Record<string, unknown>
    err['constructor'] = 'shadowed'
    err['toString'] = 'also shadowed'
    const out = toSerializable(err) as Record<string, unknown>
    expect(out['constructor']).toBe('shadowed')
    expect(out['toString']).toBe('also shadowed')
  })

  it('a throwing getter degrades only its own field', () => {
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

describe('toConsoleLine (console transport)', () => {
  const consoleLine = (level: unknown, ...data: unknown[]): string =>
    toConsoleLine({
      date: new Date('2026-08-18T00:00:00Z'),
      level: level as string,
      scope: 'main',
      data,
    })

  it('passes strings through verbatim and safely serializes objects', () => {
    const rendered = consoleLine('debug', 'plain', execSyncTimeoutError())
    expect(rendered).toContain('plain')
    expect(rendered).toContain('ETIMEDOUT')
    expect(rendered).toContain('DEBUG')
  })

  it('prints an undefined argument instead of leaving a gap in the line', () => {
    // JSON.stringify(undefined) is not a string. It used to make the argument
    // vanish silently — and "a variable was unexpectedly unset" is exactly
    // what one reads logs to find.
    expect(consoleLine('info', 'a', undefined, 1)).toContain('a undefined 1')
  })

  it('degrades an invalid Date and a missing level instead of losing the line', () => {
    // A throw in this callback makes electron-log swallow the whole line —
    // the exact failure this module exists to prevent.
    const rendered = toConsoleLine({
      date: new Date('nonsense'),
      level: undefined as unknown as string,
      data: ['still printed'],
    })
    expect(rendered).toContain('[invalid date]')
    expect(rendered).toContain('UNSET')
    expect(rendered).toContain('still printed')
  })
})

describe('safeStringify', () => {
  it('matches JSON.stringify on ordinary objects', () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}')
  })

  it('degrades throwing input to a serializationError line', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const parsed = JSON.parse(safeStringify(cyclic)) as { serializationError: string }
    expect(parsed.serializationError.length).toBeGreaterThan(0)
  })
})
