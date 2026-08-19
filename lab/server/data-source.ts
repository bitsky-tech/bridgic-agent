import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { existsSync, statSync } from 'node:fs'

import { BRIDGIC_AGENT_STATE_DB } from './constants'
import type {
  MountItem,
  OtaRecordItem,
  Page,
  PromptConversation,
  SessionPromptConversation,
  SessionItem,
  SourceHealth,
  TurnDetail,
  TurnItem,
  UserInput,
} from './types'

const SESSION_STATUSES = new Set(['finish', 'completed', 'awaiting'])
const SESSION_KINDS = new Set(['user', 'scheduled'])
const SUBAGENT_MODES = new Set(['background', 'blocking', 'rpc'])
const TURN_STATUSES = new Set([
  'awaiting_human',
  'awaiting_permission',
  'awaiting_subagents',
  'completed',
  'failed',
  'cancelled',
])
const EXECUTION_MODES = new Set(['request', 'auto', 'full'])

const DEFAULT_PAGE_SIZE = 40
const MAX_PAGE_SIZE = 100
const MAX_QUERY_LENGTH = 200

type JsonObject = Record<string, unknown>

interface SessionRow {
  id: string
  title: string | null
  status: string
  kind: string
  parent_session_id: string | null
  parent_call_id: string | null
  subagent_mode: string | null
  workspace_root: string
  schedule_id: string | null
  last_used_model: string | null
  last_answer: string | null
  created_at: string
  updated_at: string
  turn_count: number
  input_tokens: number
  output_tokens: number
}

interface TurnRow {
  id: string
  session_id: string
  session_ordinal: number
  user_input: string
  status: string
  final_answer: string | null
  error: string | null
  execution_mode: string | null
  max_rounds: number | null
  model: string | null
  input_tokens: number
  output_tokens: number
  created_at: string
  completed_at: string | null
  duration_ms: number | null
}

interface TurnDetailRow extends TurnRow {
  ota_records: string | null
  agent_state: string | null
  browser_tool_loaded: number | boolean
  workspace_tools_loaded: number | boolean
  skills_tool_loaded: number | boolean
}

interface MountRow {
  id: string
  session_id: string
  name: string
  abs_path: string
  kind: string
  created_at: string
}

interface SessionCursor {
  updatedAt: string
  id: string
}

interface TurnCursor {
  ordinal: number
  id: string
}

export class SourceUnavailableError extends Error {
  constructor(
    readonly code: 'state_db_missing' | 'state_db_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'SourceUnavailableError'
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('The pagination cursor is invalid.')
    this.name = 'InvalidCursorError'
  }
}

function asJsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function parseUserInput(value: string): UserInput {
  const parsed = parseJson(value)
  if (typeof parsed === 'string') return { text: parsed, blocks: [] }

  const record = asJsonObject(parsed)
  if (!record) return { text: '', blocks: [] }
  const textValue = record.text ?? record.input
  const blocks = Array.isArray(record.blocks)
    ? record.blocks.map(asJsonObject).filter((block): block is JsonObject => block !== null)
    : []
  return {
    text: typeof textValue === 'string' ? textValue : '',
    blocks,
  }
}

function normalizeEnum(value: unknown, allowed: Set<string>): string {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.toLowerCase()
  return allowed.has(normalized) ? normalized : 'unknown'
}

function normalizeOptionalEnum(value: unknown, allowed: Set<string>): string | null {
  if (value === null || value === undefined || value === '') return null
  const normalized = normalizeEnum(value, allowed)
  return normalized === 'unknown' ? null : normalized
}

function asNonNegativeInteger(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function asOptionalNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : null
}

function mapSession(row: SessionRow): SessionItem {
  return {
    id: row.id,
    title: row.title,
    status: normalizeEnum(row.status, SESSION_STATUSES) as SessionItem['status'],
    kind: normalizeEnum(row.kind, SESSION_KINDS) as SessionItem['kind'],
    parentSessionId: row.parent_session_id,
    parentCallId: row.parent_call_id,
    subagentMode: row.subagent_mode === null
      ? null
      : normalizeEnum(row.subagent_mode, SUBAGENT_MODES) as NonNullable<SessionItem['subagentMode']>,
    workspaceRoot: row.workspace_root,
    scheduleId: row.schedule_id,
    lastUsedModel: row.last_used_model,
    lastAnswer: row.last_answer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turnCount: asNonNegativeInteger(row.turn_count),
    inputTokens: asNonNegativeInteger(row.input_tokens),
    outputTokens: asNonNegativeInteger(row.output_tokens),
  }
}

function mapTurn(row: TurnRow): TurnItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionOrdinal: asNonNegativeInteger(row.session_ordinal),
    userInput: parseUserInput(row.user_input),
    status: normalizeEnum(row.status, TURN_STATUSES) as TurnItem['status'],
    finalAnswer: row.final_answer,
    error: row.error,
    executionMode: normalizeOptionalEnum(row.execution_mode, EXECUTION_MODES) as TurnItem['executionMode'],
    maxRounds: asOptionalNonNegativeInteger(row.max_rounds),
    model: row.model,
    inputTokens: asNonNegativeInteger(row.input_tokens),
    outputTokens: asNonNegativeInteger(row.output_tokens),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    durationMs: asOptionalNonNegativeInteger(row.duration_ms),
  }
}

function mapMount(row: MountRow): MountItem {
  const kind = normalizeEnum(row.kind, new Set(['file', 'folder']))
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    absPath: row.abs_path,
    kind: kind as MountItem['kind'],
    createdAt: row.created_at,
  }
}

function normalizeOtaRecords(turnId: string, value: string | null): OtaRecordItem[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((entry, index) => {
    const raw = asJsonObject(entry)
    if (!raw) return []
    const duration = asOptionalNonNegativeInteger(raw.turn_duration_ms)
    return [{
      id: `${turnId}:round:${index + 1}`,
      ordinal: index + 1,
      observationResult: raw.observation_result ?? null,
      thinkResult: raw.think_result ?? null,
      permission: raw.permission ?? raw.permission_result ?? null,
      actionResult: raw.action_result ?? null,
      ...(duration === null ? {} : { turnDurationMs: duration }),
      raw,
    }]
  })
}

function encodeCursor(value: SessionCursor | TurnCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new InvalidCursorError()
  }
}

function decodeSessionCursor(value: string): SessionCursor {
  const parsed = asJsonObject(decodeCursor(value))
  if (!parsed || typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') {
    throw new InvalidCursorError()
  }
  return { updatedAt: parsed.updatedAt, id: parsed.id }
}

function decodeTurnCursor(value: string): TurnCursor {
  const parsed = asJsonObject(decodeCursor(value))
  if (!parsed || !Number.isInteger(parsed.ordinal) || typeof parsed.id !== 'string') {
    throw new InvalidCursorError()
  }
  return { ordinal: Number(parsed.ordinal), id: parsed.id }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

export function normalizeLimit(value: string | null): number {
  if (!value) return DEFAULT_PAGE_SIZE
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(number, MAX_PAGE_SIZE)
}

export class StateDataSource {
  private database: Database | null = null
  private turnColumns: Set<string> | null = null

  constructor(readonly path = BRIDGIC_AGENT_STATE_DB) {}

  close(): void {
    this.database?.close(false)
    this.database = null
    this.turnColumns = null
  }

  health(): SourceHealth {
    if (!existsSync(this.path)) {
      this.close()
      return {
        status: 'missing',
        readonly: true,
        path: this.path,
        counts: null,
        sizeBytes: null,
        lastModifiedAt: null,
        error: {
          code: 'state_db_missing',
          message: 'The local Bridgic Agent state database does not exist yet.',
        },
      }
    }

    try {
      const database = this.getDatabase()
      const counts = {
        sessions: this.readCount(database, 'SELECT COUNT(*) AS count FROM sessions'),
        turns: this.readCount(database, 'SELECT COUNT(*) AS count FROM session_turns'),
        mounts: this.readCount(database, 'SELECT COUNT(*) AS count FROM session_mounts'),
      }
      const stat = statSync(this.path)
      return {
        status: 'connected',
        readonly: true,
        path: this.path,
        counts,
        sizeBytes: stat.size,
        lastModifiedAt: stat.mtime.toISOString(),
        error: null,
      }
    } catch {
      this.close()
      return {
        status: 'error',
        readonly: true,
        path: this.path,
        counts: null,
        sizeBytes: null,
        lastModifiedAt: null,
        error: {
          code: 'state_db_unavailable',
          message: 'The local Bridgic Agent state database could not be read.',
        },
      }
    }
  }

  listSessions(options: { cursor?: string; limit?: number; query?: string } = {}): Page<SessionItem> {
    const database = this.getDatabase()
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const query = (options.query ?? '').trim().slice(0, MAX_QUERY_LENGTH)
    const cursor = options.cursor ? decodeSessionCursor(options.cursor) : null
    const filters: string[] = []
    const bindings: SQLQueryBindings[] = []

    if (query) {
      const pattern = `%${escapeLike(query)}%`
      filters.push("(s.title LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\' OR s.workspace_root LIKE ? ESCAPE '\\')")
      bindings.push(pattern, pattern, pattern)
    }
    if (cursor) {
      filters.push('(s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))')
      bindings.push(cursor.updatedAt, cursor.updatedAt, cursor.id)
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const rows = this.all<SessionRow>(database, `
      SELECT
        s.id, s.title, s.status, s.kind, s.parent_session_id, s.parent_call_id,
        s.subagent_mode, s.workspace_root, s.schedule_id, s.last_used_model,
        s.last_answer, s.created_at, s.updated_at,
        COUNT(t.id) AS turn_count,
        COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(t.output_tokens), 0) AS output_tokens
      FROM sessions AS s
      LEFT JOIN session_turns AS t ON t.session_id = s.id
      ${where}
      GROUP BY s.id
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT ?
    `, [...bindings, limit + 1])

    const totalFilters = query
      ? "WHERE title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR workspace_root LIKE ? ESCAPE '\\'"
      : ''
    const totalBindings = query
      ? Array<SQLQueryBindings>(3).fill(`%${escapeLike(query)}%`)
      : []
    const total = this.readCount(database, `SELECT COUNT(*) AS count FROM sessions ${totalFilters}`, totalBindings)
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const last = pageRows.at(-1)
    return {
      items: pageRows.map(mapSession),
      nextCursor: hasMore && last
        ? encodeCursor({ updatedAt: last.updated_at, id: last.id })
        : null,
      total,
    }
  }

  listTurns(sessionId: string, options: { cursor?: string; limit?: number } = {}): Page<TurnItem> | null {
    const database = this.getDatabase()
    if (!this.sessionExists(database, sessionId)) return null

    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const cursor = options.cursor ? decodeTurnCursor(options.cursor) : null
    const cursorFilter = cursor ? 'AND (session_ordinal < ? OR (session_ordinal = ? AND id < ?))' : ''
    const bindings: SQLQueryBindings[] = cursor
      ? [sessionId, cursor.ordinal, cursor.ordinal, cursor.id, limit + 1]
      : [sessionId, limit + 1]
    const rows = this.all<TurnRow>(database, `
      SELECT ${this.turnSummaryColumns(database)}
      FROM session_turns
      WHERE session_id = ? ${cursorFilter}
      ORDER BY session_ordinal DESC, id DESC
      LIMIT ?
    `, bindings)
    const total = this.readCount(
      database,
      'SELECT COUNT(*) AS count FROM session_turns WHERE session_id = ?',
      [sessionId],
    )
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const last = pageRows.at(-1)
    return {
      items: pageRows.map(mapTurn),
      nextCursor: hasMore && last
        ? encodeCursor({ ordinal: last.session_ordinal, id: last.id })
        : null,
      total,
    }
  }

  getTurnDetail(turnId: string): TurnDetail | null {
    const database = this.getDatabase()
    const row = this.get<TurnDetailRow>(database, `
      SELECT
        ${this.turnSummaryColumns(database)},
        ota_records, agent_state, browser_tool_loaded, workspace_tools_loaded,
        skills_tool_loaded
      FROM session_turns
      WHERE id = ?
      LIMIT 1
    `, [turnId])
    if (!row) return null

    const session = this.getSession(database, row.session_id)
    if (!session) return null
    return this.mapTurnDetail(row, session, this.getMounts(database, row.session_id))
  }

  getPromptConversation(turnId: string): PromptConversation | null {
    const database = this.getDatabase()
    const targetIdentity = this.get<{ session_id: string; session_ordinal: number }>(database, `
      SELECT session_id, session_ordinal
      FROM session_turns
      WHERE id = ?
      LIMIT 1
    `, [turnId])
    if (!targetIdentity) return null

    const rows = this.all<TurnDetailRow>(database, `
      SELECT
        ${this.turnSummaryColumns(database)},
        ota_records, agent_state, browser_tool_loaded, workspace_tools_loaded,
        skills_tool_loaded
      FROM session_turns
      WHERE session_id = ? AND session_ordinal <= ?
      ORDER BY session_ordinal ASC, id ASC
    `, [targetIdentity.session_id, targetIdentity.session_ordinal])
    const session = this.getSession(database, targetIdentity.session_id)
    if (!session) return null
    const mounts = this.getMounts(database, targetIdentity.session_id)
    const turns = rows.map((row) => this.mapTurnDetail(row, session, mounts))
    const target = turns.find((turn) => turn.id === turnId)
    return target ? { target, turns } : null
  }

  getSessionPromptConversation(sessionId: string): SessionPromptConversation | null {
    const database = this.getDatabase()
    const session = this.getSession(database, sessionId)
    if (!session) return null

    const mounts = this.getMounts(database, sessionId)
    const rows = this.all<TurnDetailRow>(database, `
      SELECT
        ${this.turnSummaryColumns(database)},
        ota_records, agent_state, browser_tool_loaded, workspace_tools_loaded,
        skills_tool_loaded
      FROM session_turns
      WHERE session_id = ?
      ORDER BY session_ordinal ASC, id ASC
    `, [sessionId])
    return {
      session,
      mounts,
      turns: rows.map((row) => this.mapTurnDetail(row, session, mounts)),
    }
  }

  private getDatabase(): Database {
    if (!existsSync(this.path)) {
      this.close()
      throw new SourceUnavailableError(
        'state_db_missing',
        'The local Bridgic Agent state database does not exist yet.',
      )
    }
    if (this.database) return this.database

    try {
      const database = new Database(this.path, {
        readonly: true,
        strict: true,
      })
      database.exec('PRAGMA query_only = ON')
      this.database = database
      return database
    } catch {
      this.close()
      throw new SourceUnavailableError(
        'state_db_unavailable',
        'The local Bridgic Agent state database could not be read.',
      )
    }
  }

  private getTurnColumns(database: Database): Set<string> {
    if (this.turnColumns) return this.turnColumns
    const rows = this.all<{ name: string }>(database, 'PRAGMA table_info(session_turns)')
    this.turnColumns = new Set(rows.map((row) => row.name))
    return this.turnColumns
  }

  private turnSummaryColumns(database: Database): string {
    const columns = this.getTurnColumns(database)
    const duration = columns.has('duration_ms') ? 'duration_ms' : 'NULL AS duration_ms'
    const completedAt = columns.has('completed_at') ? 'completed_at' : 'NULL AS completed_at'
    return `
      id, session_id, session_ordinal, user_input, status, final_answer, error,
      execution_mode, max_rounds, model, input_tokens, output_tokens, created_at,
      ${duration}, ${completedAt}
    `
  }

  private getSession(database: Database, sessionId: string): SessionItem | null {
    const row = this.get<SessionRow>(database, `
      SELECT
        s.id, s.title, s.status, s.kind, s.parent_session_id, s.parent_call_id,
        s.subagent_mode, s.workspace_root, s.schedule_id, s.last_used_model,
        s.last_answer, s.created_at, s.updated_at,
        COUNT(t.id) AS turn_count,
        COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(t.output_tokens), 0) AS output_tokens
      FROM sessions AS s
      LEFT JOIN session_turns AS t ON t.session_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
      LIMIT 1
    `, [sessionId])
    return row ? mapSession(row) : null
  }

  private getMounts(database: Database, sessionId: string): MountItem[] {
    return this.all<MountRow>(database, `
      SELECT id, session_id, name, abs_path, kind, created_at
      FROM session_mounts
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
    `, [sessionId]).map(mapMount)
  }

  private mapTurnDetail(row: TurnDetailRow, session: SessionItem, mounts: MountItem[]): TurnDetail {
    const otaRecords = normalizeOtaRecords(row.id, row.ota_records)
    const otaDuration = [...otaRecords].reverse().find((record) => record.turnDurationMs !== undefined)?.turnDurationMs
    const turn = mapTurn(row)
    return {
      ...turn,
      durationMs: otaDuration ?? turn.durationMs,
      otaRecords,
      agentState: asJsonObject(parseJson(row.agent_state)),
      browserToolLoaded: Boolean(row.browser_tool_loaded),
      workspaceToolsLoaded: Boolean(row.workspace_tools_loaded),
      skillsToolLoaded: Boolean(row.skills_tool_loaded),
      mounts,
      session,
    }
  }

  private sessionExists(database: Database, sessionId: string): boolean {
    return this.get<{ id: string }>(
      database,
      'SELECT id FROM sessions WHERE id = ? LIMIT 1',
      [sessionId],
    ) !== null
  }

  private readCount(database: Database, sql: string, bindings: SQLQueryBindings[] = []): number {
    const row = this.get<{ count: number }>(database, sql, bindings)
    return asNonNegativeInteger(row?.count)
  }

  private all<T>(database: Database, sql: string, bindings: SQLQueryBindings[] = []): T[] {
    return database.query<T, SQLQueryBindings[]>(sql).all(...bindings)
  }

  private get<T>(database: Database, sql: string, bindings: SQLQueryBindings[] = []): T | null {
    return database.query<T, SQLQueryBindings[]>(sql).get(...bindings)
  }
}
