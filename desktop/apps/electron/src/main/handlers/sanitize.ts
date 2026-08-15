/**
 * Defensive sanitizer for values that go into log lines:
 *   - strings longer than 500 chars are truncated with the original length appended
 *   - arrays are capped at the first 10 elements
 *   - objects are capped at 20 keys with a remainder marker
 *   - recursion stops at depth 3 to prevent stack blowup on cyclic structures
 *   - bigint values are stringified (JSON.stringify would throw)
 *
 * Kept in its own module (no Electron imports) so it can be unit-tested in
 * a plain Bun / Node context.
 */

const ARG_TRUNCATE = 500
const ARRAY_TRUNCATE = 10
const OBJECT_KEY_LIMIT = 20
const MAX_DEPTH = 3

export function sanitizeForLogging(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '…'
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > ARG_TRUNCATE
      ? `${value.slice(0, ARG_TRUNCATE)}…(${value.length})`
      : value
  }
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    return value.slice(0, ARRAY_TRUNCATE).map((v) => sanitizeForLogging(v, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count >= OBJECT_KEY_LIMIT) {
        out['…'] = `+${Object.keys(value as object).length - count} more`
        break
      }
      out[k] = sanitizeForLogging(v, depth + 1)
      count += 1
    }
    return out
  }
  return value
}
