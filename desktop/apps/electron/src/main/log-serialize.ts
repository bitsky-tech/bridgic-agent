/**
 * Crash-proof, bounded serialization for log entries.
 *
 * The file transport's format callback runs BEFORE electron-log's own
 * serialization transform (`transforms: [removeStyles, format, ...]` in
 * electron-log 5), so it receives raw values, and a callback that throws is
 * swallowed by `Logger.processMessage` — the whole line disappears. Raw
 * values also arrive with no size ceiling, and Node error objects carry more
 * than their message.
 *
 * This module is therefore the single place that answers three questions for
 * every logged value:
 *
 *   1. Can it throw?  Cycles, throwing getters, revoked Proxies, Invalid
 *      Dates and exotic Map keys all made `JSON.stringify` (or the walk
 *      itself) throw. Every hazardous step is guarded; `toLogLine` is total.
 *   2. Can it be huge?  Strings, arrays, objects, Buffers and deep or
 *      wide graphs are all capped, and the walk has a global node budget so
 *      one log call cannot stall the main process.
 *   3. Can it leak?  Child-process errors carry the captured `stdout` /
 *      `stderr` of the command — for `shell-env.ts` that is a full `env`
 *      dump including API keys. Those fields are summarized to a length,
 *      never copied into the log.
 *
 * `handlers/sanitize.ts` delegates here with a shallower depth, so IPC
 * argument logging and transport logging share one implementation.
 */

/** Truncation markers. `…` shapes match the pre-existing sanitize.ts output. */
const DEPTH_MARKER = '…'
const CIRCULAR_MARKER = '[circular]'
const BUDGET_MARKER = '[truncated]'

/** Stacks are the payload of an error log, so they get their own, far
 *  larger ceiling than ordinary strings. */
const MAX_STACK_CHARS = 4000

export interface SerializeLimits {
  /** Nesting levels kept before a value becomes `…`. */
  maxDepth: number
  /** Longest string kept verbatim; longer ones get `…(originalLength)`. */
  maxString: number
  /** Array elements kept, plus a remainder marker. */
  maxArrayItems: number
  /** Object keys kept, plus a remainder marker. */
  maxObjectKeys: number
  /** Total nodes one conversion may visit. Bounds the cost of shared
   *  (diamond-shaped) subgraphs, which are legitimately re-walked per path. */
  maxNodes: number
}

/** Limits for the log transports. */
export const LOG_LIMITS: SerializeLimits = {
  maxDepth: 6,
  maxString: 500,
  maxArrayItems: 10,
  maxObjectKeys: 20,
  maxNodes: 5000,
}

/** Limits for per-IPC-call argument logging — same caps, shallower walk. */
export const IPC_LIMITS: SerializeLimits = { ...LOG_LIMITS, maxDepth: 3 }

/** Error fields worth keeping that `Object.keys` cannot see. */
const ERROR_EXTRA_KEYS = [
  'code',
  'errno',
  'syscall',
  'signal',
  'path',
  'cause',
  // AggregateError: undici raises one of these for a failed loopback fetch,
  // and its sub-errors name the addresses that were actually tried.
  'errors',
] as const

/** Captured child-process output. Summarized, never copied: `execSync`
 *  attaches the command's partial stdout to its timeout error, and for
 *  shell-env that stdout is the user's entire environment. */
const PROCESS_OUTPUT_KEYS = new Set(['stdout', 'stderr', 'output'])

interface Walk {
  limits: SerializeLimits
  seen: WeakSet<object>
  nodes: number
}

function isError(value: unknown): value is Error {
  return Object.prototype.toString.call(value) === '[object Error]'
}

function truncateString(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…(${value.length})` : value
}

/** Length-only summary of a value that may carry captured process output. */
function summarizeProcessOutput(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return `[${key} ${value.length} chars]`
  if (ArrayBuffer.isView(value)) return `[${key} ${value.byteLength} bytes]`
  if (Array.isArray(value)) return `[${key} ${value.length} entries]`
  return `[${key} omitted]`
}

/** Read own enumerable properties without letting a getter (or a revoked
 *  Proxy) abort the whole conversion. */
function safeEntries(value: object): Array<[string, unknown]> {
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return []
  }
  const entries: Array<[string, unknown]> = []
  for (const key of keys) {
    try {
      entries.push([key, (value as Record<string, unknown>)[key]])
    } catch (error) {
      entries.push([key, `[getter threw: ${error instanceof Error ? error.message : 'unknown'}]`])
    }
  }
  return entries
}

function errorToSerializable(error: Error, depth: number, ctx: Walk): unknown {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  out.name = String(error.name)
  out.message = truncateString(String(error.message), ctx.limits.maxString)
  if (typeof error.stack === 'string') {
    out.stack = truncateString(error.stack, MAX_STACK_CHARS)
  }
  for (const key of ERROR_EXTRA_KEYS) {
    const value = (error as unknown as Record<string, unknown>)[key]
    if (value === undefined) continue
    out[key] = walk(value, depth + 1, ctx)
  }
  for (const [key, value] of safeEntries(error)) {
    if (Object.hasOwn(out, key)) continue
    out[key] = PROCESS_OUTPUT_KEYS.has(key)
      ? summarizeProcessOutput(key, value)
      : walk(value, depth + 1, ctx)
  }
  return out
}

function objectToSerializable(value: object, depth: number, ctx: Walk): unknown {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const entries = safeEntries(value)
  const kept = entries.slice(0, ctx.limits.maxObjectKeys)
  for (const [key, entry] of kept) {
    out[key] = walk(entry, depth + 1, ctx)
  }
  if (entries.length > kept.length) {
    out[DEPTH_MARKER] = `+${entries.length - kept.length} more`
  }
  return out
}

function walk(value: unknown, depth: number, ctx: Walk): unknown {
  if (ctx.nodes >= ctx.limits.maxNodes) return BUDGET_MARKER
  ctx.nodes += 1

  if (value === null || value === undefined) return value
  switch (typeof value) {
    case 'string':
      return truncateString(value, ctx.limits.maxString)
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'function':
      return `[function ${value.name || 'anonymous'}]`
    case 'symbol':
      return String(value)
    default:
      break
  }

  const objectValue = value as object
  if (ctx.seen.has(objectValue)) return CIRCULAR_MARKER
  if (depth > ctx.limits.maxDepth) return DEPTH_MARKER
  ctx.seen.add(objectValue)
  try {
    // Every probe below (Array.isArray, instanceof, property reads) throws on
    // a revoked Proxy, so the whole branch is guarded rather than each step.
    if (isError(objectValue)) return errorToSerializable(objectValue as Error, depth, ctx)
    if (ArrayBuffer.isView(objectValue)) {
      return `[${objectValue.constructor?.name ?? 'TypedArray'} ${objectValue.byteLength} bytes]`
    }
    if (objectValue instanceof ArrayBuffer) return `[ArrayBuffer ${objectValue.byteLength} bytes]`
    if (objectValue instanceof Date) {
      return Number.isNaN(objectValue.getTime())
        ? '[Invalid Date]'
        : objectValue.toISOString()
    }
    // Pair array, not Object.fromEntries: a key that cannot be converted to a
    // property name (a null-prototype object) makes fromEntries throw.
    if (objectValue instanceof Map) {
      return walk([...objectValue.entries()], depth, ctx)
    }
    if (objectValue instanceof Set) return walk([...objectValue], depth, ctx)
    if (Array.isArray(objectValue)) {
      const kept = objectValue.slice(0, ctx.limits.maxArrayItems)
      const items: unknown[] = kept.map((item) => walk(item, depth + 1, ctx))
      if (objectValue.length > kept.length) {
        items.push(`${DEPTH_MARKER}(+${objectValue.length - kept.length} more)`)
      }
      return items
    }
    return objectToSerializable(objectValue, depth, ctx)
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : 'unknown'}]`
  } finally {
    // Released after the subtree: the guard is for cycles, not for repeated
    // (diamond-shaped) references. `maxNodes` bounds the resulting re-walks.
    ctx.seen.delete(objectValue)
  }
}

/** Convert one logged value into a bounded structure `JSON.stringify` cannot
 *  choke on. Does not throw. */
export function toSerializable(value: unknown, limits: SerializeLimits = LOG_LIMITS): unknown {
  return walk(value, 0, { limits, seen: new WeakSet(), nodes: 0 })
}

/**
 * `JSON.stringify` that never throws. The fallback line keeps the NDJSON
 * stream parseable and records that a serialization bug ate the payload —
 * the exact opposite of the silent drop this module exists to prevent.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return JSON.stringify({
      serializationError: error instanceof Error ? error.message : String(error),
    })
  }
}

/** One logged value rendered for a text (console) transport. Never throws. */
export function toLogText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return safeStringify(toSerializable(value))
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : 'unknown'}]`
  }
}

/** The message shape both transports receive from electron-log. */
export interface LogLineInput {
  date: Date
  level: string
  scope?: string
  data: unknown[]
}

/**
 * Render one NDJSON log line. Total by construction — every part that can
 * throw (the timestamp, each datum, the final stringify) is guarded
 * separately, so a hostile value degrades one field instead of dropping the
 * line. The conversion happens HERE rather than at the call site because an
 * argument expression evaluated outside this function is outside its safety
 * net — the original bug.
 */
export function toLogLine(message: LogLineInput, limits: SerializeLimits = LOG_LIMITS): string {
  let timestamp: string
  try {
    timestamp = message.date.toISOString()
  } catch {
    // RangeError on an Invalid Date.
    timestamp = '[invalid date]'
  }
  const data = message.data.map((datum) => {
    try {
      return toSerializable(datum, limits)
    } catch (error) {
      return `[unserializable: ${error instanceof Error ? error.message : 'unknown'}]`
    }
  })
  return safeStringify({
    timestamp,
    level: message.level,
    scope: message.scope,
    message: data,
  })
}
