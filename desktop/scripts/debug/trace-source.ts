import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopDebugTurn, DesktopDebugTurnsPage } from '../../apps/electron/src/shared/debug-types'

export class DebugTraceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export function debugStateDatabasePath(env: Record<string, string | undefined> = process.env): string {
  return env.BRIDGIC_AGENT_STATE_DB
    ? resolve(env.BRIDGIC_AGENT_STATE_DB)
    : join(homedir(), '.bridgic', 'AmphiAgent', 'state.db')
}

type TurnRow = Record<string, string | number | null> & {
  id: string; session_id: string; session_ordinal: number; status: string; created_at: string
}
type TurnCursor = { sessionId: string; ordinal: number; id: string }

export function validateDebugSessionId(value: string): string {
  if (!value || value.length > 256 || /[/\\\u0000-\u001f]/.test(value)) {
    throw new DebugTraceError(400, 'invalid_session', 'The Session id is invalid.')
  }
  return value
}

function readCursor(encoded: string, sessionId: string): TurnCursor {
  try {
    if (encoded.length > 2048 || !/^[\w-]+$/.test(encoded)) throw new Error()
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TurnCursor
    if (value.sessionId !== sessionId || !Number.isSafeInteger(value.ordinal) || value.ordinal < 0
      || typeof value.id !== 'string' || !value.id || value.id.length > 256) throw new Error()
    return value
  } catch {
    throw new DebugTraceError(400, 'invalid_cursor', 'The pagination cursor is invalid for this Session.')
  }
}

function storedJson(value: string | number | null | undefined): unknown {
  if (value == null) return null
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return value }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function mapTurn(row: TurnRow, columns: Set<string>): DesktopDebugTurn {
  const otaRecords = storedJson(row.ota_records)
  const agentState = storedJson(row.agent_state)
  const contextUsage = storedJson(row.context_usage)
  let otaContext = storedJson(row.ota_context)
  let otaContextSource: DesktopDebugTurn['otaContextSource'] = columns.has('ota_context') ? 'stored' : 'unavailable'
  if (!columns.has('ota_context') && columns.has('ota_records')) {
    // Mirrors SessionTurnRecord.ota_context_dump; this is stored state assembly,
    // not a reconstructed model request or a claim of captured prompt messages.
    otaContext = {
      ota_record: otaRecords ?? [], state: agentState ?? {},
      browser_tool_loaded: Boolean(row.browser_tool_loaded),
      workspace_tools_loaded: Boolean(row.workspace_tools_loaded),
      skills_tool_loaded: Boolean(row.skills_tool_loaded),
      context_usage: contextUsage,
      ...(row.status === 'failed' && row.error ? { turn_error: row.error } : {}),
    }
    otaContextSource = 'assembled_from_stored_fields'
  }
  const records = Array.isArray(otaRecords) ? otaRecords : object(otaContext)?.ota_record
  const duration = Array.isArray(records)
    ? [...records].reverse().map(record => object(record)?.turn_duration_ms).find(value => value !== undefined)
    : null
  return {
    id: row.id, sessionId: row.session_id, sessionOrdinal: row.session_ordinal,
    status: row.status, createdAt: row.created_at, userInput: storedJson(row.user_input),
    finalAnswer: typeof row.final_answer === 'string' ? row.final_answer : null,
    error: typeof row.error === 'string' ? row.error : null,
    executionMode: typeof row.execution_mode === 'string' ? row.execution_mode : null,
    maxRounds: typeof row.max_rounds === 'number' ? row.max_rounds : null,
    model: typeof row.model === 'string' ? row.model : null,
    durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null,
    otaRecords, otaContext, otaContextSource, agentState, contextUsage,
  }
}

/** Opens an existing database read-only for each page. This sees backend WAL
 * updates and database replacement without owning a writer or migration. */
export class DebugTraceSource {
  constructor(readonly dbPath = debugStateDatabasePath()) {}

  listTurns(sessionId: string, options: { before?: string; limit?: number } = {}): DesktopDebugTurnsPage {
    validateDebugSessionId(sessionId)
    const limit = options.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DebugTraceError(400, 'invalid_limit', 'Page size must be an integer from 1 to 100.')
    }
    const cursor = options.before ? readCursor(options.before, sessionId) : null
    if (!existsSync(this.dbPath)) throw new DebugTraceError(503, 'state_db_missing', 'The Desktop state database does not exist yet.')
    let db: Database | undefined
    try {
      db = new Database(this.dbPath, { readonly: true, create: false, strict: true })
      db.exec('PRAGMA query_only = ON')
      const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(session_turns)').all().map(row => row.name))
      if (!['id', 'session_id', 'session_ordinal', 'status', 'created_at'].every(name => columns.has(name))) {
        throw new DebugTraceError(503, 'unsupported_schema', 'The database does not contain the expected Session Turn schema.')
      }
      if (!db.query('SELECT id FROM sessions WHERE id = ? LIMIT 1').get(sessionId)) {
        throw new DebugTraceError(404, 'session_not_found', 'The requested Session does not exist.')
      }
      const optional = ['user_input', 'ota_records', 'ota_context', 'agent_state', 'context_usage',
        'browser_tool_loaded', 'workspace_tools_loaded', 'skills_tool_loaded', 'final_answer',
        'error', 'execution_mode', 'max_rounds', 'model']
      const select = ['id', 'session_id', 'session_ordinal', 'status', 'created_at',
        ...optional.map(name => columns.has(name) ? name : `NULL AS ${name}`)].join(', ')
      const bindings: SQLQueryBindings[] = cursor
        ? [sessionId, cursor.ordinal, cursor.ordinal, cursor.id, limit + 1]
        : [sessionId, limit + 1]
      const rows = db.query<TurnRow, SQLQueryBindings[]>(`
        SELECT ${select} FROM session_turns WHERE session_id = ?
        ${cursor ? 'AND (session_ordinal < ? OR (session_ordinal = ? AND id < ?))' : ''}
        ORDER BY session_ordinal DESC, id DESC LIMIT ?
      `).all(...bindings)
      const hasMore = rows.length > limit
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        sessionId, turns: page.map(row => mapTurn(row, columns)), hasMore,
        nextCursor: hasMore && last
          ? Buffer.from(JSON.stringify({ sessionId, ordinal: last.session_ordinal, id: last.id })).toString('base64url')
          : null,
      }
    } catch (error) {
      if (error instanceof DebugTraceError) throw error
      throw new DebugTraceError(503, 'state_db_unavailable', 'The Desktop state database could not be read.')
    } finally {
      db?.close()
    }
  }
}
