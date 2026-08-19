import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApiHandler } from './api'
import { StateDataSource } from './data-source'

const temporaryDirectories: string[] = []

function createFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bridgic-agent-lab-'))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'state.db')
  const database = new Database(databasePath)
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      parent_session_id TEXT,
      parent_call_id TEXT,
      subagent_mode TEXT,
      workspace_root TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      schedule_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_model TEXT,
      last_answer TEXT
    );
    CREATE TABLE session_turns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_ordinal INTEGER NOT NULL,
      user_input TEXT NOT NULL,
      ota_records TEXT,
      agent_state TEXT,
      browser_tool_loaded INTEGER NOT NULL,
      workspace_tools_loaded INTEGER NOT NULL,
      skills_tool_loaded INTEGER NOT NULL,
      status TEXT NOT NULL,
      final_answer TEXT,
      error TEXT,
      execution_mode TEXT,
      max_rounds INTEGER,
      model TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      duration_ms INTEGER,
      completed_at TEXT
    );
    CREATE TABLE session_mounts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      abs_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)

  database.run(`
    INSERT INTO sessions VALUES (
      'session_new', 'local', NULL, NULL, NULL, '/tmp/new', 'Newest session',
      'AWAITING', 'USER', NULL, '2026-08-18 08:00:00', '2026-08-18 09:00:00',
      'gpt-5', 'Latest answer'
    )
  `)
  database.run(`
    INSERT INTO sessions VALUES (
      'session_old', 'local', 'session_new', 'call_parent', 'BACKGROUND', '/tmp/old',
      'Older session', 'FINISH', 'SCHEDULED', 'schedule_1',
      '2026-08-17 08:00:00', '2026-08-17 09:00:00', NULL, NULL
    )
  `)
  database.run(`
    INSERT INTO session_turns VALUES (
      'turn_new', 'local', 'session_new', 1,
      '{"text":"Run the report","blocks":[{"type":"text","value":"Run the report"}]}',
      '[{"observation_result":"tool output","think_result":{"step_content":"Inspect files","tool_calls":[]},"permission":{"execution_mode":"auto"},"action_result":{"results":[]},"turn_duration_ms":3210}]',
      '{"main":"done"}', 1, 1, 0, 'COMPLETED', 'Done', NULL, 'AUTO', 8,
      'gpt-5', 1200, 90, '2026-08-18 08:10:00', 3000, '2026-08-18 08:10:04'
    )
  `)
  database.run(`
    INSERT INTO session_turns VALUES (
      'turn_old', 'local', 'session_new', 0, 'not-json', 'not-json', '[]',
      0, 0, 0, 'FAILED', NULL, 'boom', 'unexpected', NULL, NULL, 5, 2,
      '2026-08-18 08:00:00', NULL, NULL
    )
  `)
  database.run(`
    INSERT INTO session_mounts VALUES (
      'mnt_1', 'session_new', 'local', '.work', '/tmp/new/.work', 'folder',
      '2026-08-18 08:00:00'
    )
  `)
  database.close()
  return databasePath
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('StateDataSource', () => {
  test('reports a fixed read-only source and counts only allowlisted data', () => {
    const source = new StateDataSource(createFixture())
    expect(source.health()).toMatchObject({
      status: 'connected',
      readonly: true,
      counts: { sessions: 2, turns: 2, mounts: 1 },
      error: null,
    })
    source.close()
  })

  test('paginates sessions with opaque cursors and normalizes persisted enums', () => {
    const source = new StateDataSource(createFixture())
    const firstPage = source.listSessions({ limit: 1 })
    expect(firstPage.total).toBe(2)
    expect(firstPage.items[0]).toMatchObject({
      id: 'session_new',
      status: 'awaiting',
      kind: 'user',
      turnCount: 2,
      inputTokens: 1205,
      outputTokens: 92,
    })
    expect(firstPage.nextCursor).toBeString()

    const secondPage = source.listSessions({ cursor: firstPage.nextCursor ?? undefined, limit: 1 })
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.items[0]).toMatchObject({
      id: 'session_old',
      status: 'finish',
      kind: 'scheduled',
      subagentMode: 'background',
    })
    expect(source.listSessions({ query: 'Newest' }).items.map((item) => item.id)).toEqual(['session_new'])
    source.close()
  })

  test('returns lightweight turn pages and a safely parsed turn detail', () => {
    const source = new StateDataSource(createFixture())
    const page = source.listTurns('session_new', { limit: 10 })
    expect(page?.items.map((item) => item.id)).toEqual(['turn_new', 'turn_old'])
    expect(page?.items[0]).toMatchObject({
      sessionOrdinal: 1,
      status: 'completed',
      executionMode: 'auto',
      userInput: { text: 'Run the report' },
    })

    const detail = source.getTurnDetail('turn_new')
    expect(detail).toMatchObject({
      id: 'turn_new',
      durationMs: 3210,
      agentState: { main: 'done' },
      browserToolLoaded: true,
      workspaceToolsLoaded: true,
      session: { id: 'session_new' },
      mounts: [{ id: 'mnt_1', kind: 'folder' }],
      otaRecords: [{
        id: 'turn_new:round:1',
        ordinal: 1,
        observationResult: 'tool output',
        turnDurationMs: 3210,
      }],
    })

    expect(source.getTurnDetail('turn_old')).toMatchObject({
      userInput: { text: '', blocks: [] },
      executionMode: null,
      otaRecords: [],
      agentState: null,
    })

    const conversation = source.getPromptConversation('turn_new')
    expect(conversation?.target.id).toBe('turn_new')
    expect(conversation?.turns.map((turn) => turn.id)).toEqual(['turn_old', 'turn_new'])

    const sessionConversation = source.getSessionPromptConversation('session_new')
    expect(sessionConversation?.session.id).toBe('session_new')
    expect(sessionConversation?.mounts.map((mount) => mount.id)).toEqual(['mnt_1'])
    expect(sessionConversation?.turns.map((turn) => turn.id)).toEqual(['turn_old', 'turn_new'])
    expect(sessionConversation?.turns[0]?.otaRecords).toEqual([])
    expect(sessionConversation?.turns[1]?.otaRecords).toHaveLength(1)
    expect(source.getSessionPromptConversation('missing')).toBeNull()
    source.close()
  })
})

describe('local Lab API', () => {
  test('serves health, pagination and turn detail without any mutation route', async () => {
    const source = new StateDataSource(createFixture())
    const handle = createApiHandler(source)

    const health = await handle(new Request('http://127.0.0.1/api/source/health'))
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'connected', readonly: true })

    const sessions = await handle(new Request('http://127.0.0.1/api/sessions?limit=1'))
    expect(await sessions.json()).toMatchObject({ total: 2, items: [{ id: 'session_new' }] })

    const turn = await handle(new Request('http://127.0.0.1/api/turns/turn_new'))
    expect(await turn.json()).toMatchObject({ item: { id: 'turn_new' } })

    const prompt = await handle(new Request(
      'http://127.0.0.1/api/turns/turn_new/rounds/turn_new%3Around%3A1/prompt',
    ))
    expect(prompt.status).toBe(200)
    expect(await prompt.json()).toMatchObject({
      item: {
        turnId: 'turn_new',
        roundId: 'turn_new:round:1',
        roundIndex: 0,
        stage: 'main',
      },
    })

    const prompts = await handle(new Request(
      'http://127.0.0.1/api/sessions/session_new/prompts',
    ))
    expect(prompts.status).toBe(200)
    expect(await prompts.json()).toMatchObject({
      total: 1,
      items: [
        { turnId: 'turn_new', roundId: 'turn_new:round:1', roundIndex: 0 },
      ],
    })

    const writeAttempt = await handle(new Request('http://127.0.0.1/api/sessions', { method: 'POST' }))
    expect(writeAttempt.status).toBe(405)
    expect(await writeAttempt.json()).toMatchObject({ error: { code: 'method_not_allowed' } })
    source.close()
  })

  test('returns explicit missing-source and not-found errors', async () => {
    const missingPath = join(mkdtempSync(join(tmpdir(), 'bridgic-agent-lab-missing-')), 'state.db')
    temporaryDirectories.push(join(missingPath, '..'))
    const source = new StateDataSource(missingPath)
    const handle = createApiHandler(source)

    const health = await handle(new Request('http://127.0.0.1/api/source/health'))
    expect(await health.json()).toMatchObject({ status: 'missing', readonly: true })

    const sessions = await handle(new Request('http://127.0.0.1/api/sessions'))
    expect(sessions.status).toBe(503)
    expect(await sessions.json()).toMatchObject({ error: { code: 'state_db_missing' } })
  })

  test('returns a not-found response for a missing Session prompt collection', async () => {
    const source = new StateDataSource(createFixture())
    const handle = createApiHandler(source)

    const response = await handle(new Request('http://127.0.0.1/api/sessions/missing/prompts'))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'session_not_found' } })
    source.close()
  })

  test('only includes OTA records with a completed think result in Session prompt analysis', async () => {
    const databasePath = createFixture()
    const database = new Database(databasePath)
    const otaRecords = JSON.stringify([
      { observation_result: 'opened but no model result' },
      { think_result: { step_content: 'Completed request', tool_calls: [] } },
      { reasoning_content: 'interrupted stream without a final think result' },
    ])
    database.query('UPDATE session_turns SET ota_records = ? WHERE id = ?').run(otaRecords, 'turn_new')
    database.close()

    const source = new StateDataSource(databasePath)
    const handle = createApiHandler(source)
    const response = await handle(new Request('http://127.0.0.1/api/sessions/session_new/prompts'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [{ turnId: 'turn_new', roundId: 'turn_new:round:2', roundIndex: 1 }],
    })
    source.close()
  })
})
