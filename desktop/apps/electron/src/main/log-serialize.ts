/**
 * Crash-proof serialization for log entries.
 *
 * The file transport's format callback runs BEFORE electron-log's own
 * serialization transform (`transforms: [removeStyles, format, ...]` in
 * electron-log 5), so it receives raw values. Two raw shapes broke the
 * previous bare `JSON.stringify`:
 *
 *   1. Circular references — e.g. the Error thrown by `execSync` on timeout
 *      carries `err.error === err`. `JSON.stringify` throws, and electron-log
 *      swallows a throwing transport via its no-op `processInternalErrorFn`,
 *      so the entire line vanished. That silently destroyed the one warn line
 *      explaining why shell-env loading failed on slow (Intel) machines.
 *   2. `Error` instances — `message`/`stack` are non-enumerable, so every
 *      `log.error(msg, err)` call persisted `{}`.
 *
 * `toSerializable` fixes both; `safeStringify` guarantees the caller can
 * never throw even if a future value type slips through.
 */

/** Matches electron-log's own default object depth. */
const MAX_DEPTH = 6

/** Error fields worth keeping in a log line. `cause` is handled separately
 *  because it needs recursive (depth-limited) serialization. */
const ERROR_EXTRA_KEYS = ['code', 'errno', 'syscall', 'signal', 'path'] as const

function errorToSerializable(error: Error, depth: number, seen: WeakSet<object>): unknown {
  const out: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
  for (const key of ERROR_EXTRA_KEYS) {
    const value = (error as unknown as Record<string, unknown>)[key]
    if (value !== undefined) out[key] = toSerializableInner(value, depth - 1, seen)
  }
  if (error.cause !== undefined) {
    out.cause = toSerializableInner(error.cause, depth - 1, seen)
  }
  // Own enumerable extras (execSync attaches stdout/stderr/spawnargs, fetch
  // errors attach hostnames, ...). The self-referential `error` property is
  // caught by the `seen` set and rendered as '[circular]'.
  for (const [key, value] of Object.entries(error)) {
    if (key in out) continue
    out[key] = toSerializableInner(value, depth - 1, seen)
  }
  return out
}

function toSerializableInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return `${value}n`
    case 'function':
      return `[function ${value.name || 'anonymous'}]`
    case 'symbol':
      return String(value)
    default:
      break
  }

  const objectValue = value as object
  if (seen.has(objectValue)) return '[circular]'
  if (depth < 1) return Array.isArray(value) ? '[array]' : '[object]'
  seen.add(objectValue)
  try {
    if (value instanceof Error) return errorToSerializable(value, depth, seen)
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Map) {
      return toSerializableInner(Object.fromEntries(value), depth, seen)
    }
    if (value instanceof Set) {
      return toSerializableInner([...value], depth, seen)
    }
    if (Array.isArray(value)) {
      return value.map((item) => toSerializableInner(item, depth - 1, seen))
    }
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(objectValue)) {
      out[key] = toSerializableInner(entry, depth - 1, seen)
    }
    return out
  } finally {
    // Release after the subtree: the guard is for cycles, not for repeated
    // (diamond-shaped) references to the same object.
    seen.delete(objectValue)
  }
}

/** Convert one logged value into a structure `JSON.stringify` cannot choke on. */
export function toSerializable(value: unknown): unknown {
  return toSerializableInner(value, MAX_DEPTH, new WeakSet())
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
