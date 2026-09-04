/**
 * Tests for lib/amphi-ws-connection.ts — the single persistent chat WS that
 * demuxes every session's events off one socket. A `socketFactory` is injected
 * so a `FakeSocket` drives the handshake / frames without a real network.
 *
 * Locks the behaviors that the per-turn → per-client refactor depends on:
 * each chat resets the translator (distinct message_start per turn), interleaved
 * sessions don't cross-talk, cancel finalizes locally + absorbs residual frames,
 * and an unexpected close fails in-flight turns (no infinite spinner).
 */
import { describe, it, expect, jest } from 'bun:test'
import { AmphiWsConnection, type Dispatch } from '../amphiWsConnection'
import { i18n } from '../i18n'
import type { BackendEndpoint } from '@shared/types'
import type { AgentEvent } from '@shared/types'

const ENDPOINT: BackendEndpoint = {
  baseUrl: 'http://127.0.0.1:7421',
  token: 'tok',
  version: null,
  startedAt: null,
  wsPath: '/ws',
  runtimeFile: null,
  logFile: null,
  clientId: 'gui-test',
}

/** Minimal WebSocket stand-in: records sent frames, drives callbacks. */
class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0 // CONNECTING
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3 // CLOSED
  }
  // ── test drivers ──
  open(): void {
    this.readyState = 1 // OPEN
    this.onopen?.()
  }
  recv(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

interface Captured {
  sid: string
  event: AgentEvent
}

/** A ready connection wired to a fake socket, collecting dispatched events. */
function setup(): { conn: AmphiWsConnection; sock: FakeSocket; events: Captured[] } {
  const sock = new FakeSocket()
  const events: Captured[] = []
  const dispatch: Dispatch = (sid, event) => events.push({ sid, event })
  const conn = new AmphiWsConnection(() => sock as unknown as WebSocket)
  conn.configure(ENDPOINT, dispatch)
  sock.open() // → sends hello
  sock.recv({ type: 'ready' }) // → phase ready
  return { conn, sock, events }
}

/** Like `setup`, but the factory mints a FRESH socket per call so reconnects
 *  (a new socket) are observable via `sockets.length`. The first socket is
 *  handshaked to `ready`. */
function setupMulti(): { conn: AmphiWsConnection; sockets: FakeSocket[]; events: Captured[] } {
  const sockets: FakeSocket[] = []
  const events: Captured[] = []
  const dispatch: Dispatch = (sid, event) => events.push({ sid, event })
  const conn = new AmphiWsConnection(() => {
    const s = new FakeSocket()
    sockets.push(s)
    return s as unknown as WebSocket
  })
  conn.configure(ENDPOINT, dispatch)
  sockets[0]?.open()
  sockets[0]?.recv({ type: 'ready' })
  return { conn, sockets, events }
}

const typesFor = (events: Captured[], sid: string): string[] =>
  events.filter((e) => e.sid === sid).map((e) => e.event.type)

const messageStartIds = (events: Captured[]): string[] =>
  events
    .filter((e) => e.event.type === 'message_start')
    .map((e) => (e.event.type === 'message_start' ? e.event.messageId : ''))

const textDeltas = (events: Captured[], sid: string): string[] =>
  events
    .filter((e) => e.sid === sid && e.event.type === 'text_delta')
    .map((e) => (e.event.type === 'text_delta' ? e.event.text : ''))

describe('AmphiWsConnection', () => {
  it('handshake: sends hello, then subscribes system topic on ready', () => {
    const { sock } = setup()
    const frames = sock.frames()
    expect(frames[0]?.['type']).toBe('hello')
    expect(frames[0]?.['token']).toBe('tok')
    const subs = frames.filter((f) => f['type'] === 'subscribe')
    expect(
      subs.some((f) => Array.isArray(f['topics']) && (f['topics'] as string[]).includes('system')),
    ).toBe(true)
  })

  it('handshake: carries the UI language, which no request header could', () => {
    // The browser WebSocket API forbids custom headers, so a daemon relying on
    // Accept-Language would render in the OS language rather than the user's choice.
    const activeLanguage = i18n.resolvedLanguage ?? i18n.language
    const { sock } = setup()
    expect(sock.frames()[0]?.['locale']).toBe(activeLanguage)
  })

  it('switching UI language sends set_locale instead of reconnecting', () => {
    const { conn, sock } = setup()
    const before = sock.frames().length

    conn.setLocale('en')

    expect(sock.frames().slice(before)).toEqual([{ type: 'set_locale', locale: 'en' }])
    expect(sock.readyState).toBe(1) // still the same live socket
  })

  it('queues set_locale sent before the handshake completes', () => {
    const sock = new FakeSocket()
    const conn = new AmphiWsConnection(() => sock as unknown as WebSocket)
    conn.configure(ENDPOINT, () => {})

    conn.setLocale('en') // socket not open yet → outbox

    sock.open()
    sock.recv({ type: 'ready' })
    expect(sock.frames()).toContainEqual({ type: 'set_locale', locale: 'en' })
  })

  it('runs the ready callback after the initial handshake and every reconnect', () => {
    const sockets: FakeSocket[] = []
    let readyCount = 0
    const conn = new AmphiWsConnection(() => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    })
    conn.configure(ENDPOINT, () => {}, () => { readyCount += 1 })
    sockets[0]?.open()
    sockets[0]?.recv({ type: 'ready' })
    expect(readyCount).toBe(1)

    conn.configure({ ...ENDPOINT, token: 'tok-reconnected' }, () => {}, () => {
      readyCount += 1
    })
    sockets[1]?.open()
    sockets[1]?.recv({ type: 'ready' })
    expect(readyCount).toBe(2)
  })

  it('chat subscribes the session once, then sends the chat frame', () => {
    const { conn, sock } = setup()
    sock.sent.length = 0 // drop handshake frames
    conn.chat('A', 'hi', [])
    const frames = sock.frames()
    expect(frames).toEqual([
      { type: 'subscribe', topics: ['session:A'] },
      { type: 'chat', session_id: 'A', input: 'hi', blocks: [] },
    ])
    // second chat on same session does NOT re-subscribe
    sock.sent.length = 0
    sock.recv({ type: 'final', session_id: 'A', answer: '', tokens_spent: 0 })
    conn.chat('A', 'again', [])
    expect(sock.frames()).toEqual([{ type: 'chat', session_id: 'A', input: 'again', blocks: [] }])
  })

  it('chat carries the structured blocks in the frame (ordered text/mention)', () => {
    const { conn, sock } = setup()
    sock.sent.length = 0
    const blocks = [
      { type: 'text' as const, value: '请参考 ' },
      { type: 'mention' as const, id: 'mnt_a', label: '用户画像.xlsx', group: '文件/文件夹' },
    ]
    conn.chat('A', '请参考 @用户画像.xlsx', blocks)
    expect(sock.frames().find((f) => f['type'] === 'chat')).toEqual({
      type: 'chat',
      session_id: 'A',
      input: '请参考 @用户画像.xlsx',
      blocks,
    })
    // Empty blocks → still sent as an empty array (blocks is always present).
    sock.recv({ type: 'final', session_id: 'A', answer: '', tokens_spent: 0 })
    sock.sent.length = 0
    conn.chat('A', 'again', [])
    expect(sock.frames().find((f) => f['type'] === 'chat')).toEqual({
      type: 'chat',
      session_id: 'A',
      input: 'again',
      blocks: [],
    })
  })

  it('keeps the active turn when a second chat is attempted', () => {
    const { conn, sock, events } = setup()
    sock.sent.length = 0

    conn.chat('A', 'first', [])
    conn.chat('A', 'second', [])

    expect(sock.frames().filter((frame) => frame['type'] === 'chat')).toEqual([
      { type: 'chat', session_id: 'A', input: 'first', blocks: [] },
    ])
    expect(typesFor(events, 'A')).toEqual(['message_start', 'command_error'])

    sock.recv({ type: 'token', session_id: 'A', text: 'first answer' })
    sock.recv({ type: 'final', session_id: 'A', answer: 'first answer', tokens_spent: 1 })
    expect(textDeltas(events, 'A')).toEqual(['first answer'])
    expect(typesFor(events, 'A')).toContain('message_stop')
  })

  it('projects a rejected command as a transient command error', () => {
    const { conn, sock, events } = setup()
    conn.chat('A', 'hello', [])

    sock.recv({
      type: 'cmd_error',
      for: 'chat',
      session_id: 'A',
      message: 'cannot start turn',
    })

    expect(typesFor(events, 'A')).toEqual([
      'message_start',
      'stream_discard',
      'command_error',
    ])
    expect(events.at(-1)?.event).toEqual({
      type: 'command_error',
      message: 'cannot start turn',
    })
  })

  it('workflowConfirm sends a dedicated workflow_confirm frame', () => {
    const { conn, sock, events } = setup()
    sock.sent.length = 0
    conn.workflowConfirm('A', {
      request_id: 'req-1',
      action: 'confirm',
      name: '小红书内容爬虫',
    })
    expect(sock.frames()).toEqual([
      { type: 'subscribe', topics: ['session:A'] },
      {
        type: 'workflow_confirm',
        session_id: 'A',
        request_id: 'req-1',
        action: 'confirm',
        name: '小红书内容爬虫',
      },
    ])
    expect(events.filter((e) => e.sid === 'A' && e.event.type === 'message_start')).toHaveLength(1)
  })

  it('workflowConfirm can save an edited Workflow as a new definition', () => {
    const { conn, sock } = setup()
    sock.sent.length = 0
    conn.workflowConfirm('A', {
      request_id: 'req-save-as-new',
      action: 'save_as_new',
      name: '小红书内容爬虫 副本',
    })
    expect(sock.frames()).toEqual([
      { type: 'subscribe', topics: ['session:A'] },
      {
        type: 'workflow_confirm',
        session_id: 'A',
        request_id: 'req-save-as-new',
        action: 'save_as_new',
        name: '小红书内容爬虫 副本',
      },
    ])
  })

  it('buildConfirm sends a dedicated build_confirm frame', () => {
    const { conn, sock, events } = setup()
    sock.sent.length = 0
    conn.buildConfirm('A', {
      request_id: 'build-1',
      action: 'confirm',
    })
    expect(sock.frames()).toEqual([
      { type: 'subscribe', topics: ['session:A'] },
      {
        type: 'build_confirm',
        session_id: 'A',
        request_id: 'build-1',
        action: 'confirm',
      },
    ])
    expect(events.filter((e) => e.sid === 'A' && e.event.type === 'message_start')).toHaveLength(1)
  })

  it('taskConfirm sends a dedicated task_confirm frame', () => {
    const { conn, sock, events } = setup()
    sock.sent.length = 0
    conn.taskConfirm('A', {
      request_id: 'task-1',
      action: 'revise',
      feedback: '补充失败分支',
    })
    expect(sock.frames()).toEqual([
      { type: 'subscribe', topics: ['session:A'] },
      {
        type: 'task_confirm',
        session_id: 'A',
        request_id: 'task-1',
        action: 'revise',
        feedback: '补充失败分支',
      },
    ])
    expect(events.filter((e) => e.sid === 'A' && e.event.type === 'message_start')).toHaveLength(1)
  })

  it('presentationOutlineConfirm sends the edited outline without a chat message', () => {
    const { conn, sock, events } = setup()
    sock.sent.length = 0
    conn.presentationOutlineConfirm('A', {
      request_id: 'presentation-outline-1',
      chapters: [{
        id: 'chapter-001',
        title: 'Opening',
        slides: [{
          id: 'slide-001',
          title: 'Why this matters',
          key_message: 'Set the stakes.',
          content_outline: ['Frame the decision.', 'Show why it matters now.'],
          source_ids: ['source-001'],
        }],
      }],
    })
    expect(sock.frames()).toEqual([
      { type: 'subscribe', topics: ['session:A'] },
      {
        type: 'presentation_outline_confirm',
        session_id: 'A',
        request_id: 'presentation-outline-1',
        chapters: [{
          id: 'chapter-001',
          title: 'Opening',
          slides: [{
            id: 'slide-001',
            title: 'Why this matters',
            key_message: 'Set the stakes.',
            content_outline: ['Frame the decision.', 'Show why it matters now.'],
            source_ids: ['source-001'],
          }],
        }],
      },
    ])
    expect(events.filter((e) => e.sid === 'A' && e.event.type === 'message_start')).toHaveLength(1)
  })

  it('presentationTemplateSelection sends a dedicated selection frame', () => {
    const { conn, sock, events } = setup()
    sock.sent.length = 0
    conn.presentationTemplateSelection('A', {
      request_id: 'template-selection-1',
      action: 'select',
      template_id: 'template-editorial-1',
    })
    expect(sock.frames()).toEqual([
      { type: 'subscribe', topics: ['session:A'] },
      {
        type: 'presentation_template_selection',
        session_id: 'A',
        request_id: 'template-selection-1',
        action: 'select',
        template_id: 'template-editorial-1',
      },
    ])
    expect(events.filter((e) => e.sid === 'A' && e.event.type === 'message_start')).toHaveLength(1)
  })

  it('recovers the sole active turn when an older daemon omits cmd_error session_id', () => {
    const { conn, sock, events } = setup()
    conn.taskConfirm('A', {
      request_id: 'task-1',
      action: 'confirm',
    })

    sock.recv({
      type: 'cmd_error',
      for: 'task_confirm',
      message: 'invalid interaction frame',
    })

    expect(typesFor(events, 'A')).toEqual([
      'message_start',
      'stream_discard',
      'command_error',
    ])
  })

  it('lets the parent Session controller subscribe a discovered Child before its first frame', () => {
    const { conn, sock, events } = setup()
    sock.sent.length = 0
    sock.recv({
      type: 'subagent.event',
      session_id: 'A',
      invocation_id: 'inv-1',
      parent_invocation_id: 'inv-root',
      parent_tool_call_id: 'call-1',
      mode: 'rpc',
      goal: 'Inspect files',
      status: 'running',
      phase: 'started',
      answer: null,
      error: null,
    })
    expect(sock.frames()).toEqual([{ type: 'subscribe', topics: ['session:inv-1'] }])
    conn.subscribe('inv-1')
    expect(sock.frames()).toEqual([{ type: 'subscribe', topics: ['session:inv-1'] }])
    sock.recv({ type: 'token', session_id: 'inv-1', text: 'working' })
    expect(events[0]).toEqual({
      sid: 'A',
      event: {
        type: 'subagent_event',
        invocationId: 'inv-1',
        parentToolCallId: 'call-1',
        mode: 'rpc',
        goal: 'Inspect files',
        status: 'running',
        phase: 'started',
        answer: undefined,
        error: undefined,
      },
    })
    expect(typesFor(events, 'inv-1')).toEqual(['message_start', 'text_delta'])
    expect(textDeltas(events, 'inv-1')).toEqual(['working'])
  })

  it('keeps the Child topic idle after completion without discarding its Turn', () => {
    const { sock, events } = setup()
    sock.recv({
      type: 'subagent.event',
      session_id: 'A',
      invocation_id: 'child-complete',
      parent_invocation_id: null,
      parent_tool_call_id: 'call-1',
      mode: 'blocking',
      goal: 'complete',
      status: 'running',
      phase: 'started',
      answer: null,
      error: null,
    })
    sock.sent.length = 0
    sock.recv({
      type: 'subagent.event',
      session_id: 'A',
      invocation_id: 'child-complete',
      parent_invocation_id: null,
      parent_tool_call_id: 'call-1',
      mode: 'blocking',
      goal: 'complete',
      status: 'completed',
      phase: 'status',
      answer: 'done',
      error: null,
    })
    expect(sock.frames()).toEqual([])
    sock.recv({
      type: 'final',
      session_id: 'child-complete',
      answer: 'done',
      tokens_spent: 1,
    })
    expect(sock.frames()).toEqual([])
    expect(typesFor(events, 'child-complete')).toEqual([
      'message_start',
      'text_delta',
      'message_stop',
      'done',
    ])
    expect(typesFor(events, 'child-complete')).not.toContain('stream_discard')
  })

  it('retains a Child topic when an attempt parks for human input', () => {
    const { sock } = setup()
    sock.recv({
      type: 'subagent.event',
      session_id: 'A',
      invocation_id: 'child-waiting',
      parent_invocation_id: null,
      parent_tool_call_id: 'call-1',
      mode: 'blocking',
      goal: 'ask',
      status: 'running',
      phase: 'started',
      answer: null,
      error: null,
    })
    sock.sent.length = 0
    sock.recv({
      type: 'final',
      session_id: 'child-waiting',
      answer: '',
      tokens_spent: 1,
    })
    sock.recv({
      type: 'subagent.event',
      session_id: 'A',
      invocation_id: 'child-waiting',
      parent_invocation_id: null,
      parent_tool_call_id: 'call-1',
      mode: 'blocking',
      goal: 'ask',
      status: 'awaiting_human',
      phase: 'status',
      answer: null,
      error: null,
    })
    expect(sock.frames()).toEqual([])
  })

  it('routes a Child interaction through the normal Child Session reducer path', () => {
    const { conn, sock, events } = setup()
    conn.subscribe('inv-1')
    sock.recv({
      type: 'human_request',
      session_id: 'inv-1',
      request_id: 'req-1',
      questions: [{ question: 'Continue?', options: [{ label: 'yes' }] }],
    })
    expect(typesFor(events, 'inv-1')).toEqual(['message_start', 'human_request'])
    expect(events[1]).toEqual({
      sid: 'inv-1',
      event: {
        type: 'human_request',
        requestId: 'req-1',
        questions: [{ question: 'Continue?', options: [{ label: 'yes' }] }],
      },
    })
  })

  it('opens a turn lazily when the daemon resumes a parent internally', () => {
    const { conn, sock, events } = setup()
    conn.chat('A', 'delegate', [])
    sock.recv({ type: 'final', session_id: 'A', answer: '', tokens_spent: 0 })
    events.length = 0

    sock.recv({ type: 'token', session_id: 'A', text: 'joined' })
    expect(typesFor(events, 'A')).toEqual(['message_start', 'text_delta'])
    expect(textDeltas(events, 'A')).toEqual(['joined'])
  })

  it('optimistically opens the turn (message_start before any daemon frame) for first-token loading', () => {
    const { conn, sock, events } = setup()
    conn.chat('A', 'hi', [])
    // Before ANY daemon frame: exactly one message_start is dispatched, so the
    // Pipeline can show the loading dots during the first-token gap.
    expect(events.filter((e) => e.sid === 'A' && e.event.type === 'message_start')).toHaveLength(1)
    // The first token must NOT re-emit message_start (pre-marked `started`) — it
    // just streams text into the already-open turn; otherwise the bubble resets.
    sock.recv({ type: 'token', session_id: 'A', text: 'hi' })
    expect(events.filter((e) => e.sid === 'A' && e.event.type === 'message_start')).toHaveLength(1)
    expect(textDeltas(events, 'A')).toEqual(['hi'])
  })

  it('resets the translator each chat: two turns get distinct message ids', () => {
    const { conn, sock, events } = setup()
    conn.chat('A', 'one', [])
    sock.recv({ type: 'token', session_id: 'A', text: 'first' })
    sock.recv({ type: 'final', session_id: 'A', answer: 'first', tokens_spent: 0 })
    conn.chat('A', 'two', [])
    sock.recv({ type: 'token', session_id: 'A', text: 'second' })
    sock.recv({ type: 'final', session_id: 'A', answer: 'second', tokens_spent: 0 })

    const ids = messageStartIds(events)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1]) // each turn is its own bubble
    expect(textDeltas(events, 'A')).toEqual(['first', 'second'])
  })

  it('demuxes interleaved sessions without cross-talk', () => {
    const { conn, sock, events } = setup()
    conn.chat('A', 'a', [])
    conn.chat('B', 'b', [])
    sock.recv({ type: 'token', session_id: 'A', text: 'AA' })
    sock.recv({ type: 'token', session_id: 'B', text: 'BB' })
    sock.recv({ type: 'final', session_id: 'A', answer: 'AA', tokens_spent: 0 })
    sock.recv({ type: 'final', session_id: 'B', answer: 'BB', tokens_spent: 0 })

    expect(textDeltas(events, 'A')).toEqual(['AA'])
    expect(textDeltas(events, 'B')).toEqual(['BB'])
    // every captured event carries the correct session tag
    expect(events.every((e) => e.sid === 'A' || e.sid === 'B')).toBe(true)
  })

  it('cancel finalizes locally, absorbs residual frames, and releases on cancelled', () => {
    const { conn, sock, events } = setup()
    conn.chat('A', 'a', [])
    sock.recv({ type: 'token', session_id: 'A', text: 'partial' })
    conn.cancel('A')
    // residual frames after a local cancel are dropped, not dispatched
    sock.recv({ type: 'token', session_id: 'A', text: 'more' })
    sock.recv({ type: 'cancelled', session_id: 'A' })
    conn.chat('A', 'next', [])

    const t = typesFor(events, 'A')
    expect(t).toContain('message_stop')
    expect(t).toContain('done')
    expect(textDeltas(events, 'A')).toEqual(['partial']) // 'more' absorbed
    expect(sock.frames().filter((frame) => frame['type'] === 'chat')).toHaveLength(2)
  })

  it('fails in-flight turns on an unexpected close', () => {
    const { conn, sock, events } = setup()
    conn.chat('A', 'a', [])
    sock.recv({ type: 'token', session_id: 'A', text: 'x' }) // turn started
    const before = events.length
    sock.drop(1006)
    const errs = events.slice(before).filter((e) => e.sid === 'A' && e.event.type === 'error')
    expect(errs.length).toBeGreaterThanOrEqual(1)
  })
})

describe('AmphiWsConnection · close-code reconnect policy (WS-1)', () => {
  it('stops auto-reconnect after an auth/protocol close (4401 / 1002)', () => {
    jest.useFakeTimers()
    try {
      for (const code of [4401, 1002]) {
        const { sockets } = setupMulti()
        const created = sockets.length
        sockets[created - 1]?.drop(code)
        jest.advanceTimersByTime(60_000)
        // No reconnect scheduled → no new socket is ever minted.
        expect(sockets.length).toBe(created)
      }
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps backoff-reconnecting after a transient close (1006 / 1012)', () => {
    jest.useFakeTimers()
    try {
      for (const code of [1006, 1012]) {
        const { sockets } = setupMulti()
        const created = sockets.length
        sockets[created - 1]?.drop(code)
        jest.advanceTimersByTime(1_000) // past RETRY_BASE_MS
        // Backoff fired → a fresh socket was minted for the reconnect.
        expect(sockets.length).toBe(created + 1)
      }
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('AmphiWsConnection · unsubscribe (WS-2)', () => {
  it('sends an unsubscribe frame for the session topic', () => {
    const { conn, sockets } = setupMulti()
    conn.chat('A', 'hi', []) // → subscribes session:A
    const sock = sockets[0]
    if (!sock) throw new Error('no socket')
    sock.sent.length = 0
    conn.unsubscribe('A')
    expect(sock.frames()).toEqual([{ type: 'unsubscribe', topics: ['session:A'] }])
  })

  it('drops the topic so a later reconnect does NOT re-subscribe it', () => {
    const { conn, sockets, events } = setupMulti()
    conn.chat('A', 'hi', [])
    conn.chat('B', 'hi', [])
    conn.unsubscribe('A')
    // Force a deterministic fresh connection: a new token changes the endpoint
    // key → synchronous close + reconnect (no timers needed).
    const dispatch: Dispatch = (sid, event) => events.push({ sid, event })
    conn.configure({ ...ENDPOINT, token: 'tok2' }, dispatch)
    const sock1 = sockets[1]
    if (!sock1) throw new Error('no reconnect socket')
    sock1.open()
    sock1.recv({ type: 'ready' }) // → onReady re-subscribes the surviving set
    const resubscribed = sock1
      .frames()
      .filter((f) => f['type'] === 'subscribe')
      .flatMap((f) => f['topics'] as string[])
    expect(resubscribed).toContain('session:B')
    expect(resubscribed).toContain('system')
    expect(resubscribed).not.toContain('session:A')
  })

  it('is a no-op for a never-subscribed session', () => {
    const { conn, sockets } = setupMulti()
    const sock = sockets[0]
    if (!sock) throw new Error('no socket')
    sock.sent.length = 0
    conn.unsubscribe('never')
    expect(sock.frames()).toEqual([])
  })

  it('detaches transport without discarding an in-flight local Turn', () => {
    const { conn, sockets, events } = setupMulti()
    const sock = sockets[0]
    if (!sock) throw new Error('no socket')
    conn.chat('A', 'hi', [])
    sock.recv({ type: 'token', session_id: 'A', text: 'first' })
    sock.sent.length = 0

    conn.unsubscribe('A')
    expect(typesFor(events, 'A')).not.toContain('stream_discard')
    conn.subscribe('A')
    sock.recv({ type: 'token', session_id: 'A', text: ' second' })
    sock.recv({ type: 'final', session_id: 'A', answer: 'first second', tokens_spent: 1 })

    expect(messageStartIds(events)).toHaveLength(1)
    expect(textDeltas(events, 'A')).toEqual(['first', ' second'])
  })

  it('explicitly releases a Session tree and discards only its transient streams', () => {
    const { conn, sockets, events } = setupMulti()
    const sock = sockets[0]
    if (!sock) throw new Error('no socket')
    conn.chat('A', 'delegate', [])
    sock.recv({
      type: 'subagent.event',
      session_id: 'A',
      invocation_id: 'child-A',
      parent_invocation_id: null,
      parent_tool_call_id: 'call-1',
      mode: 'blocking',
      goal: 'inspect',
      status: 'running',
      phase: 'started',
      answer: null,
      error: null,
    })
    sock.recv({ type: 'token', session_id: 'child-A', text: 'working' })
    sock.sent.length = 0

    conn.releaseSessionTree('A')

    const releasedTopics = sock.frames()
      .filter((frame) => frame['type'] === 'unsubscribe')
      .flatMap((frame) => frame['topics'] as string[])
    expect(releasedTopics).toEqual(['session:A', 'session:child-A'])
    expect(typesFor(events, 'A')).toContain('stream_discard')
    expect(typesFor(events, 'child-A')).toContain('stream_discard')

    sock.sent.length = 0
    sock.recv({
      type: 'subagent.event',
      session_id: 'A',
      invocation_id: 'late-child',
      parent_invocation_id: null,
      parent_tool_call_id: 'late-call',
      mode: 'blocking',
      goal: 'late',
      status: 'running',
      phase: 'started',
      answer: null,
      error: null,
    })
    expect(sock.frames()).toEqual([])
  })
})

describe('AmphiWsConnection · endpoint isolation', () => {
  it('clearEndpoint closes the singleton socket and drops queued commands', () => {
    const sockets: FakeSocket[] = []
    const events: Captured[] = []
    const conn = new AmphiWsConnection(() => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    })
    const dispatch: Dispatch = (sid, event) => events.push({ sid, event })

    conn.configure(ENDPOINT, dispatch)
    conn.chat('A', 'must-not-replay', []) // queued before Ready
    const oldSocket = sockets[0]
    conn.clearEndpoint()

    expect(oldSocket?.readyState).toBe(3)
    expect(typesFor(events, 'A')).toContain('error')

    conn.configure({ ...ENDPOINT, token: 'tok-new' }, dispatch)
    const nextSocket = sockets[1]
    nextSocket?.open()
    nextSocket?.recv({ type: 'ready' })
    expect(nextSocket?.frames().some((frame) => frame['type'] === 'chat')).toBe(false)
  })

  it('endpoint replacement drops old outbox and ignores late old-socket frames', () => {
    const sockets: FakeSocket[] = []
    const conn = new AmphiWsConnection(() => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    })

    conn.configure(ENDPOINT, () => {})
    conn.chat('A', 'old-daemon-command', []) // queued before Ready
    const oldSocket = sockets[0]
    conn.configure({ ...ENDPOINT, token: 'tok-new' }, () => {})
    const nextSocket = sockets[1]

    // Superseded callbacks cannot mark the new transport Ready or flush queues.
    oldSocket?.open()
    oldSocket?.recv({ type: 'ready' })
    expect(nextSocket?.frames()).toEqual([])

    nextSocket?.open()
    nextSocket?.recv({ type: 'ready' })
    const nextFrames = nextSocket?.frames() ?? []
    expect(nextFrames.some((frame) => frame['type'] === 'chat')).toBe(false)
    expect(nextFrames).toContainEqual({ type: 'subscribe', topics: ['session:A'] })
  })

  it('reports 4401 through a throttled callback but keeps 1002 protocol-only', () => {
    jest.useFakeTimers()
    try {
      const sockets: FakeSocket[] = []
      const authFailures = jest.fn()
      const conn = new AmphiWsConnection(() => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket as unknown as WebSocket
      })
      const configure = (): void => conn.configure(ENDPOINT, () => {}, () => {}, authFailures)

      configure()
      sockets[0]?.open()
      sockets[0]?.drop(4401)
      expect(authFailures).toHaveBeenCalledTimes(1)
      expect(authFailures).toHaveBeenLastCalledWith({ code: 4401 })

      // Same endpoint inside the throttle window does not fan out refreshes.
      configure()
      sockets[1]?.open()
      sockets[1]?.drop(4401)
      expect(authFailures).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(5_000)
      configure()
      sockets[2]?.open()
      sockets[2]?.drop(4401)
      expect(authFailures).toHaveBeenCalledTimes(2)

      configure()
      sockets[3]?.open()
      sockets[3]?.drop(1002)
      expect(authFailures).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('AmphiWsConnection · schedule.notify relay', () => {
  /** Stub `window.api.notify.show` for one test; returns the mock + restore. */
  function stubNotifyApi(result = { shown: true }) {
    const show = jest.fn(async () => result)
    const prev = (globalThis as Record<string, unknown>)['window']
    ;(globalThis as Record<string, unknown>)['window'] = { api: { notify: { show } } }
    return { show, restore: () => ((globalThis as Record<string, unknown>)['window'] = prev) }
  }

  const FRAME = {
    type: 'schedule.notify',
    kind: 'failed',
    title: 'Scheduled task failed',
    body: '“Backup” failed this run.',
    session_id: 'sess-9',
    schedule_id: 'sched-1',
    schedule_name: 'Backup',
  }

  it('relays a valid frame to main as a native-toast IPC call', () => {
    const { show, restore } = stubNotifyApi()
    try {
      const { sock, events } = setup()
      sock.recv(FRAME)
      expect(show).toHaveBeenCalledTimes(1)
      expect(show).toHaveBeenCalledWith({
        title: 'Scheduled task failed',
        body: '“Backup” failed this run.',
        sessionId: 'sess-9',
        scheduleId: 'sched-1',
        kind: 'failed',
      })
      // Global side effect only — nothing dispatched into session state.
      expect(events).toEqual([])
    } finally {
      restore()
    }
  })

  it('drops an invalid frame without calling main and without throwing', () => {
    const { show, restore } = stubNotifyApi()
    try {
      const { sock, events } = setup()
      sock.recv({ type: 'schedule.notify', kind: 'exploded', session_id: 'x' })
      expect(show).not.toHaveBeenCalled()
      expect(events).toEqual([])
    } finally {
      restore()
    }
  })

  it('survives the frame when window.api is absent (bare test env)', () => {
    const { sock } = setup()
    // No stub installed: optional chaining must make this a no-op.
    expect(() => sock.recv(FRAME)).not.toThrow()
  })
})
