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
 *   3. Can it leak?  Child-process output carries the command's captured
 *      `stdout` / `stderr` — for `shell-env.ts` that is a full `env` dump
 *      including API keys. Those fields are summarized to a length wherever
 *      they appear (on an Error, on a plain `spawnSync` result), and Node
 *      folds the same output into `error.message`, which is cut back to its
 *      first line.
 *
 * This is the ONLY place log values are converted. IPC argument logging used
 * to pre-shrink its arguments and hand the result here, which re-truncated
 * the first pass's truncation markers — see `handlers/logged-handle.ts`.
 */

/** Truncation markers. */
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
 *  shell-env that stdout is the user's entire environment. Checked on every
 *  object, not just on Errors — a `spawnSync` *result* (`{status, stdout,
 *  stderr}`) is an ordinary object carrying exactly the same payload. */
const PROCESS_OUTPUT_KEYS = new Set(['stdout', 'stderr', 'output'])

/** Node builds a failed `exec` message as `Command failed: <cmd>\n<stderr>`,
 *  so the captured output arrives inside `message` as well, where the key
 *  check above cannot see it. */
const COMMAND_FAILURE_PREFIX = 'Command failed:'

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

/** The first line of a failed-command message. The rest is the child's
 *  captured stderr, which is the payload this module refuses to copy. */
function redactCommandFailure(message: string): string {
  if (!message.startsWith(COMMAND_FAILURE_PREFIX)) return message
  const cut = message.indexOf('\n')
  if (cut < 0) return message
  return `${message.slice(0, cut)} [+${message.length - cut - 1} chars of output]`
}

/** Read own enumerable properties without letting a getter (or a revoked
 *  Proxy) abort the whole conversion. Only `limit` values are read: the key
 *  list is free, but every read past the cap runs a getter whose result is
 *  discarded — side effects included. */
function safeEntries(
  value: object,
  limit: number,
): { entries: Array<[string, unknown]>; total: number } {
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return { entries: [], total: 0 }
  }
  const entries: Array<[string, unknown]> = []
  for (const key of keys.slice(0, limit)) {
    try {
      entries.push([key, (value as Record<string, unknown>)[key]])
    } catch (error) {
      entries.push([key, `[getter threw: ${error instanceof Error ? error.message : 'unknown'}]`])
    }
  }
  return { entries, total: keys.length }
}

/** Walk one property, summarizing it instead when the key names captured
 *  child-process output. */
function walkProperty(key: string, value: unknown, depth: number, ctx: Walk): unknown {
  return PROCESS_OUTPUT_KEYS.has(key)
    ? summarizeProcessOutput(key, value)
    : walk(value, depth + 1, ctx)
}

/** Convert at most `maxArrayItems` items, then state how many were dropped.
 *  Takes an iterable rather than an array so a large Map or Set is never
 *  materialized just to throw all but ten of its entries away. */
function boundedItems(
  source: Iterable<unknown>,
  total: number,
  depth: number,
  ctx: Walk,
): unknown[] {
  const items: unknown[] = []
  for (const item of source) {
    if (items.length >= ctx.limits.maxArrayItems) break
    items.push(walk(item, depth + 1, ctx))
  }
  if (total > items.length) {
    items.push(`${DEPTH_MARKER}(+${total - items.length} more)`)
  }
  return items
}

function errorToSerializable(error: Error, depth: number, ctx: Walk): unknown {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const rawMessage = String(error.message)
  const message = redactCommandFailure(rawMessage)
  out.name = String(error.name)
  out.message = truncateString(message, ctx.limits.maxString)
  if (typeof error.stack === 'string') {
    // The stack embeds the message verbatim ahead of the frames, so redacting
    // only `message` would leave the captured output one field to the right.
    const stack =
      message === rawMessage ? error.stack : error.stack.replace(rawMessage, message)
    out.stack = truncateString(stack, MAX_STACK_CHARS)
  }
  for (const key of ERROR_EXTRA_KEYS) {
    const value = (error as unknown as Record<string, unknown>)[key]
    if (value === undefined) continue
    out[key] = walk(value, depth + 1, ctx)
  }
  const { entries } = safeEntries(error, ctx.limits.maxObjectKeys)
  for (const [key, value] of entries) {
    if (Object.hasOwn(out, key)) continue
    out[key] = walkProperty(key, value, depth, ctx)
  }
  return out
}

function objectToSerializable(value: object, depth: number, ctx: Walk): unknown {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const { entries, total } = safeEntries(value, ctx.limits.maxObjectKeys)
  for (const [key, entry] of entries) {
    out[key] = walkProperty(key, entry, depth, ctx)
  }
  if (total > entries.length) {
    out[DEPTH_MARKER] = `+${total - entries.length} more`
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
      return boundedItems(objectValue.entries(), objectValue.size, depth, ctx)
    }
    if (objectValue instanceof Set) {
      return boundedItems(objectValue.values(), objectValue.size, depth, ctx)
    }
    if (Array.isArray(objectValue)) {
      return boundedItems(objectValue, objectValue.length, depth, ctx)
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

/** A fresh node budget. One per log CALL, not per argument: the budget is a
 *  promise about how long one line can take, and `log.error(msg, a, b, c)`
 *  would otherwise get one full budget per argument. */
function newWalk(limits: SerializeLimits): Walk {
  return { limits, seen: new WeakSet(), nodes: 0 }
}

/** Convert one logged value into a bounded structure `JSON.stringify` cannot
 *  choke on. Does not throw. */
export function toSerializable(value: unknown, limits: SerializeLimits = LOG_LIMITS): unknown {
  return walk(value, 0, newWalk(limits))
}

/** Convert every argument of one log call under a single shared budget. */
function toSerializableData(data: unknown[], limits: SerializeLimits): unknown[] {
  const ctx = newWalk(limits)
  return data.map((datum) => {
    try {
      return walk(datum, 0, ctx)
    } catch (error) {
      return `[unserializable: ${error instanceof Error ? error.message : 'unknown'}]`
    }
  })
}

/**
 * `JSON.stringify` that never throws. The fallback line keeps the NDJSON
 * stream parseable and records that a serialization bug ate the payload —
 * the exact opposite of the silent drop this module exists to prevent.
 */
export function safeStringify(value: unknown): string {
  try {
    // `undefined`, functions and symbols stringify to `undefined` — not a
    // string, despite the signature. Fall back rather than return a lie.
    return JSON.stringify(value) ?? String(value)
  } catch (error) {
    return JSON.stringify({
      serializationError: error instanceof Error ? error.message : String(error),
    })
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
  return safeStringify({
    timestamp: toTimestamp(message.date),
    level: message.level,
    scope: message.scope,
    message: toSerializableData(message.data, limits),
  })
}

/** `Date#toISOString` raises RangeError on an Invalid Date, and this runs
 *  inside a format callback whose throw costs the whole line. */
function toTimestamp(date: Date): string {
  try {
    return date.toISOString()
  } catch {
    return '[invalid date]'
  }
}

/**
 * Render one human-readable line for the console transport. Guarded for the
 * same reason as {@link toLogLine} and not just for the same values: this
 * callback also reads `level`, which is `undefined` on a message forwarded by
 * a third-party logger, and `.toUpperCase()` on it throws. electron-log
 * swallows a throwing transport, so an unguarded field here does not degrade
 * the line — it deletes it.
 */
export function toConsoleLine(message: LogLineInput, limits: SerializeLimits = LOG_LIMITS): string {
  const scope = message.scope ? `[${message.scope}]` : ''
  const level = String(message.level ?? 'unset').toUpperCase().padEnd(5)
  // Strings pass through verbatim (a console line is for reading, not
  // parsing); everything else is JSON. Checked against the raw datum so the
  // rule is about what was logged, not about what the walk produced.
  const serialized = toSerializableData(message.data, limits)
  const data = message.data
    .map((datum, index) => (typeof datum === 'string' ? datum : safeStringify(serialized[index])))
    .join(' ')
  return `${toTimestamp(message.date)} ${level} ${scope} ${data}`
}
