/**
 * Defensive sanitizer for values that go into IPC log lines:
 *   - strings longer than 500 chars are truncated with the original length appended
 *   - arrays are capped at the first 10 elements
 *   - objects are capped at 20 keys with a remainder marker
 *   - recursion stops at depth 3 to prevent stack blowup on cyclic structures
 *   - bigint values are stringified (JSON.stringify would throw)
 *
 * The walk itself lives in `../log-serialize` — the transport layer needs the
 * same guarantees (plus cycle safety, Error awareness and process-output
 * redaction), and two divergent serializers meant IPC arguments were walked
 * twice under two different sets of limits. This module now only pins the
 * shallower depth used for per-call argument logging.
 */
import { IPC_LIMITS, toSerializable } from '../log-serialize'

export function sanitizeForLogging(value: unknown): unknown {
  return toSerializable(value, IPC_LIMITS)
}
