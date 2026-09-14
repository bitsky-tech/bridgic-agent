import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DebugTraceSource, debugStateDatabasePath } from './trace-source'
import { createDebugTraceHandler, startDebugTraceServer } from './trace-server'
import type { DesktopDebugTurnsPage } from '../../apps/electron/src/shared/debug-types'

let directory: string
let dbPath: string
let writer: Database
const rawRecords = [{
  round_id: 'recorded-round', turn_duration_ms: 987,
  llm_request: { messages: [{ role: 'system', content: 'captured test instruction' }], model: 'captured-model', temperature: 0.2 },
  future_field: { preserved: true },
}]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'desktop-debug-trace-'))
  dbPath = join(directory, 'state.db')
  writer = new Database(dbPath)
  // Matches the persisted fields in src/amphi_store/_session_turn.py.
  writer.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE session_turns (
      id TEXT PRIMARY KEY, user_id TEXT, session_id TEXT NOT NULL,
      session_ordinal INTEGER NOT NULL, user_input TEXT, ota_records TEXT,
      agent_state TEXT, browser_tool_loaded INTEGER, workspace_tools_loaded INTEGER,
      skills_tool_loaded INTEGER, status TEXT, final_answer TEXT, error TEXT,
      execution_mode TEXT, max_rounds INTEGER, model TEXT, context_usage TEXT,
      created_at TEXT, UNIQUE(session_id, session_ordinal)
    );
    INSERT INTO sessions VALUES ('session-a'), ('session-b'), ('empty');
  `)
  for (const [id, session, ordinal] of [
    ['turn-a1', 'session-a', 1], ['turn-a2', 'session-a', 2],
    ['turn-a3', 'session-a', 3], ['turn-b3', 'session-b', 3],
  ] as const) {
    writer.query(`INSERT INTO session_turns
      (id, session_id, session_ordinal, user_input, ota_records, agent_state,
       browser_tool_loaded, workspace_tools_loaded, skills_tool_loaded,
       status, execution_mode, max_rounds, model, context_usage, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, 'completed', 'auto', 10, ?, ?, ?)
    `).run(id, session, ordinal, JSON.stringify({ text: 'stored input', blocks: [] }),
      JSON.stringify(rawRecords), JSON.stringify({ think: { type: 'task' } }),
      'original-model', JSON.stringify({ model_id: 'captured-usage-model', input_tokens: 15 }),
      '2026-09-11 10:00:00')
  }
})

afterEach(() => {
  writer.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('Desktop debug trace source', () => {
  it('pages by stored Session order without cross-session rows or duplicates after new Turns arrive', () => {
    const source = new DebugTraceSource(dbPath)
    const first = source.listTurns('session-a', { limit: 2 })
    expect(first.turns.map(turn => turn.id)).toEqual(['turn-a3', 'turn-a2'])
    expect(first.hasMore).toBe(true)
    writer.query(`INSERT INTO session_turns
      (id, session_id, session_ordinal, status, created_at) VALUES ('turn-a4', 'session-a', 4, 'completed', '2026-09-11 09:00:00')`).run()
    const next = source.listTurns('session-a', { limit: 2, before: first.nextCursor! })
    expect(next.turns.map(turn => turn.id)).toEqual(['turn-a1'])
    expect(next.nextCursor).toBeNull()
    expect(next.hasMore).toBe(false)
    expect(source.listTurns('session-a', { limit: 1 }).turns[0]?.id).toBe('turn-a4')
    expect(() => source.listTurns('session-b', { before: first.nextCursor! })).toThrow('invalid for this Session')
  })

  it('preserves captured model data and unknown OTA fields, with explicit assembled context provenance', () => {
    const turn = new DebugTraceSource(dbPath).listTurns('session-a', { limit: 1 }).turns[0]!
    expect(turn.otaRecords).toEqual(rawRecords)
    expect(turn.model).toBe('original-model')
    expect(turn.contextUsage).toEqual({ model_id: 'captured-usage-model', input_tokens: 15 })
    expect(turn.durationMs).toBe(987)
    expect(turn.otaContextSource).toBe('assembled_from_stored_fields')
    expect(turn.otaContext).toEqual({
      ota_record: rawRecords, state: { think: { type: 'task' } },
      browser_tool_loaded: true, workspace_tools_loaded: false, skills_tool_loaded: true,
      context_usage: { model_id: 'captured-usage-model', input_tokens: 15 },
    })
  })

  it('returns missing and malformed data without replacing it with guessed history', () => {
    writer.query('UPDATE session_turns SET ota_records = ?, model = NULL, context_usage = NULL WHERE id = ?').run('{invalid trace', 'turn-a3')
    const turn = new DebugTraceSource(dbPath).listTurns('session-a', { limit: 1 }).turns[0]!
    expect(turn.otaRecords).toBe('{invalid trace')
    expect(turn.model).toBeNull()
    expect(turn.contextUsage).toBeNull()
    expect(turn.durationMs).toBeNull()
  })

  it('retains an existing raw ota_context column instead of assembling over it', () => {
    const captured = { ota_record: rawRecords, captured_model: { model: 'past-model' }, custom: 42 }
    writer.exec('ALTER TABLE session_turns ADD COLUMN ota_context TEXT')
    writer.query('UPDATE session_turns SET ota_context = ? WHERE id = ?').run(JSON.stringify(captured), 'turn-a3')
    const turn = new DebugTraceSource(dbPath).listTurns('session-a', { limit: 1 }).turns[0]!
    expect(turn.otaContextSource).toBe('stored')
    expect(turn.otaContext).toEqual(captured)
  })

  it('never mutates the database or creates a missing database', () => {
    const before = readFileSync(dbPath)
    const source = new DebugTraceSource(dbPath)
    source.listTurns('session-a')
    expect(source.listTurns('empty')).toEqual({ sessionId: 'empty', turns: [], nextCursor: null, hasMore: false })
    expect(readFileSync(dbPath).equals(before)).toBe(true)
    const absent = join(directory, 'absent.db')
    expect(() => new DebugTraceSource(absent).listTurns('session-a')).toThrow('does not exist yet')
    expect(existsSync(absent)).toBe(false)
  })

  it('rejects invalid pages, cursors and missing Session ids', () => {
    const source = new DebugTraceSource(dbPath)
    for (const limit of [0, -1, 101, 1.5, NaN]) {
      expect(() => source.listTurns('session-a', { limit })).toThrow('Page size')
    }
    for (const before of ['not-json', '*', Buffer.from('{"sessionId":"session-a","ordinal":-1,"id":"t"}').toString('base64url')]) {
      expect(() => source.listTurns('session-a', { before })).toThrow('cursor')
    }
    expect(() => source.listTurns('missing')).toThrow('does not exist')
    expect(() => source.listTurns('session-a/other')).toThrow('Session id')
    expect(debugStateDatabasePath({ BRIDGIC_AGENT_STATE_DB: dbPath })).toBe(dbPath)
  })
})

describe('Desktop debug HTTP boundary', () => {
  const token = 'a'.repeat(64)
  const origin = 'http://localhost:5173'
  const url = 'http://127.0.0.1:12345/__debug-api/sessions/session-a/turns?limit=1'
  const headers = { authorization: `Bearer ${token}`, origin }

  it('requires launcher authorization, accepts only its renderer origin and GET', async () => {
    const handle = createDebugTraceHandler({ source: new DebugTraceSource(dbPath), token, origin })
    expect(handle(new Request(url)).status).toBe(401)
    expect(handle(new Request(url, { headers: { ...headers, origin: 'https://foreign.example' } })).status).toBe(403)
    expect(handle(new Request(url, { method: 'POST', headers })).status).toBe(405)
    const response = handle(new Request(url, { headers }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json() as DesktopDebugTurnsPage).turns[0]?.id).toBe('turn-a3')
    expect(handle(new Request(url.replace('session-a', '%2F'), { headers })).status).toBe(400)
  })

  it('serves only the read-only route on a launcher-owned loopback listener', async () => {
    const service = startDebugTraceServer({ token, origin, dbPath })
    try {
      expect(new URL(service.url).hostname).toBe('127.0.0.1')
      const response = await fetch(`${service.url}/__debug-api/sessions/session-b/turns`, { headers })
      expect(response.status).toBe(200)
      expect((await response.json() as DesktopDebugTurnsPage).turns.map(turn => turn.id)).toEqual(['turn-b3'])
      expect((await fetch(`${service.url}/__debug-api/sql`, { headers })).status).toBe(404)
    } finally { await service.stop() }
  })
})
