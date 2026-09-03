/**
 * Single long-lived chat WebSocket per client — the canonical transport for
 * the daemon's multiplexed `/ws` surface: one connection per client. Replaces
 * the old one-WS-per-turn
 * `streamTurnWs` generator.
 *
 * One persistent socket multiplexes every session: `hello` once, `subscribe`
 * each `session:<id>` topic on first use, `chat` many times. All sessions'
 * events return on this one connection and are demuxed by each frame's
 * `session_id` into per-session translator state, then dispatched into the
 * renderer's `applyAgentEventAtom` reducer.
 *
 * Key invariants:
 *  - Module singleton (`getAmphiWsConnection()`), lifecycle follows the module,
 *    NOT a React component — so StrictMode double-mount / HMR don't churn it.
 *  - `dispatch` is INJECTED by `hooks/useWsConnection.ts` via
 *    `useSetAtom(applyAgentEventAtom)` — never `getDefaultStore()` (antipattern
 *    §E: the Provider has no `store` prop, so a module-scope write would hit a
 *    different store and silently no-op).
 *  - Each `chat()` resets that session's translator (fresh messageId +
 *    `initialTranslatorState`) so every turn re-injects `message_start` — else
 *    turn N+1's tokens accrue into turn N's finalized bubble.
 *  - `translateTurnEvent` (lib/turn-translate.ts) is reused verbatim; only the
 *    state container moved from generator-local to a per-session Map.
 */
import type {
  AgentEvent,
  AcceptRuleFrame,
  BackendEndpoint,
  BuildConfirmFrame,
  TurnEvent,
  ChatBlock,
  ClientFrame,
  HelloFrame,
  ChoiceAnswerFrame,
  PermissionAnswerFrame,
  PresentationOutlineConfirmFrame,
  TaskConfirmFrame,
  WorkflowConfirmFrame,
} from '@shared/types'
import { CLIENT_FRAME, CONTROL_FRAME, TURN_EVENT, SYSTEM_TOPIC, sessionTopic } from '@shared/types'
import { z } from 'zod'
import { initialTranslatorState, translateTurnEvent, type TranslatorState } from './turnTranslate'
import { rlog } from './logger'
import { i18n } from './i18n'

/** Dispatch one translated event into the reducer, tagged with its session. */
export type Dispatch = (sessionId: string, event: AgentEvent) => void
export type ReadyHandler = () => void
export type AuthFailureHandler = (failure: { code: 4401 }) => void

/** Per-session in-flight turn state, threaded across the demuxed frames. */
interface TurnState {
  messageId: string
  translator: TranslatorState
  /** Cancelled locally (Stop) — absorb residual frames until a terminal event. */
  cancelled: boolean
}

type Phase = 'idle' | 'connecting' | 'ready' | 'closed'

const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 10_000
/** Avoid a closed/reconfigured socket hammering main with the same stale token. */
const AUTH_FAILURE_THROTTLE_MS = 5_000

/** WS close codes that reconnecting can't fix: a wrong/expired
 *  token (4401) or a malformed `hello` (1002) is rejected identically on every
 *  retry, so auto-reconnect would just be a permanent 10s storm. We stop for
 *  these — recovery comes when the main process re-discovers the daemon and
 *  broadcasts a fresh endpoint, which re-`configure`s this connection with a new
 *  key. Transient codes (1006 network blip, 1012 service restart) keep
 *  backoff-reconnecting. */
const NO_RETRY_CLOSE_CODES = new Set<number>([1002, 4401])

const subAgentEventSchema = z.object({
  session_id: z.string(),
  invocation_id: z.string(),
  parent_invocation_id: z.string().nullable(),
  parent_tool_call_id: z.string().nullable(),
  mode: z.enum(['background', 'blocking', 'rpc']),
  goal: z.string(),
  status: z.string(),
  phase: z.enum(['started', 'status']),
  answer: z.string().nullable(),
  error: z.string().nullable(),
})

const scheduleNotifySchema = z.object({
  kind: z.enum(['failed', 'action_required']),
  title: z.string(),
  body: z.string(),
  session_id: z.string(),
  schedule_id: z.string(),
  schedule_name: z.string(),
})

/** Stable identity of an endpoint — reconnect only when one of these changes. */
function getEndpointKey(e: BackendEndpoint): string {
  return `${e.baseUrl}|${e.token ?? ''}|${e.wsPath ?? ''}|${e.clientId ?? ''}`
}

/** Derive a `ws(s)://…` URL from an `http(s)://…` base + path. */
function toWsUrl(baseUrl: string, wsPath: string | null): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/^http/i, 'ws')
  return `${base}${wsPath ?? '/ws'}`
}

export class AmphiWsConnection {
  /** @param socketFactory injectable for tests (default: real `WebSocket`). */
  constructor(
    private readonly socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  private ws: WebSocket | null = null
  private phase: Phase = 'idle'
  private endpoint: BackendEndpoint | null = null
  private endpointKey = ''
  private dispatch: Dispatch = () => {}
  private readyHandler: ReadyHandler = () => {}
  private authFailureHandler: AuthFailureHandler = () => {}
  /** Authoritative set of subscribed session ids — re-sent on every reconnect
   *  (a fresh daemon connection has no subscriptions). */
  private readonly subscribed = new Set<string>()
  private readonly turns = new Map<string, TurnState>()
  private readonly releasedSessions = new Set<string>()
  /** Child topic ownership belongs to the parent Session controller, not to
   *  transient Modal/Drawer views. An idle topic waiting for another attempt is
   *  not an active consumer of a finished backend stream. */
  private readonly childParents = new Map<string, string>()
  /** Frames queued while not `ready`, bound to the endpoint that accepted them. */
  private outbox: Array<{ endpointKey: string; frame: ClientFrame }> = []
  private retryMs = RETRY_BASE_MS
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private lastAuthFailure: { endpointKey: string; at: number } | null = null

  /**
   * Point the connection at an endpoint + dispatch sink. Idempotent: an
   * unchanged endpoint only refreshes `dispatch` (StrictMode/HMR safe); a
   * changed endpoint (daemon restart → new port/token) tears down + reconnects.
   * A token-less endpoint is left unconnected (a `hello` would 4401 → reconnect
   * storm); a later token-bearing snapshot reconnects.
   */
  configure(
    endpoint: BackendEndpoint,
    dispatch: Dispatch,
    readyHandler: ReadyHandler = () => {},
    authFailureHandler: AuthFailureHandler = () => {},
  ): void {
    this.dispatch = dispatch
    this.readyHandler = readyHandler
    this.authFailureHandler = authFailureHandler
    const key = getEndpointKey(endpoint)
    if (key === this.endpointKey && (this.phase === 'connecting' || this.phase === 'ready')) {
      return
    }
    const endpointChanged = this.endpointKey !== key
    if (endpointChanged) {
      // Commands belong to the daemon credentials under which the user sent
      // them. Replaying them after a token/endpoint replacement can duplicate
      // work or resume a turn that no longer exists.
      this.discardOutbox()
      if (this.endpoint !== null || this.turns.size > 0) {
        this.failAllActiveTurns(i18n.t('error.endpointChangedReconnect'))
      }
    }
    this.endpointKey = key
    this.endpoint = endpoint
    this.close(true)
    if (!endpoint.token) return
    this.connect()
  }

  /**
   * Remove an endpoint that main no longer considers usable. The module
   * singleton outlives React mounts, so endpoint=null must explicitly retire
   * its socket and any commands queued for the old daemon.
   */
  clearEndpoint(): void {
    if (this.endpoint !== null || this.turns.size > 0) {
      this.failAllActiveTurns(i18n.t('error.gatewayUnavailableForChat'))
    }
    this.discardOutbox()
    this.endpoint = null
    this.endpointKey = ''
    this.lastAuthFailure = null
    this.close(true)
  }

  /** Retarget the daemon's display language after the user switches UI language.
   *
   *  Takes effect on the turns that follow — a turn already in flight captured its locale
   *  when it started, and rewriting it mid-stream would splice two languages into one
   *  reply. Queued like any other frame when the socket isn't ready yet, so a switch made
   *  during a reconnect still lands. */
  setLocale(locale: string): void {
    this.send({ type: CLIENT_FRAME.SetLocale, locale })
  }

  /** Start one chat turn for `sessionId`. Subscribes on first use; always
   *  resets this session's translator so the turn re-injects `message_start`.
   *  `blocks` = the structured input (text / @mention / /slash) in order; the
   *  daemon walks them to inline-resolve @mention paths in place. `input` is
   *  the clean flattened display text. */
  chat(sessionId: string, input: string, blocks: ChatBlock[]): void {
    if (!this.openTurn(sessionId)) return
    this.send({ type: CLIENT_FRAME.Chat, session_id: sessionId, input, blocks })
  }

  /** Resume Clarify with the user's per-rule decisions and optional supplement. */
  acceptRule(sessionId: string, payload: Omit<AcceptRuleFrame, 'type' | 'session_id'>): void {
    if (!this.openTurn(sessionId)) return
    this.send({
      type: CLIENT_FRAME.AcceptRule,
      session_id: sessionId,
      ...payload,
    })
  }

  /** Resume Main after the user decides whether to enter Workflow Build. */
  buildConfirm(sessionId: string, payload: Omit<BuildConfirmFrame, 'type' | 'session_id'>): void {
    if (!this.openTurn(sessionId)) return
    this.send({
      type: CLIENT_FRAME.BuildConfirm,
      session_id: sessionId,
      ...payload,
    })
  }

  /** Resume Clarify after the user reviews the rendered task contract. */
  taskConfirm(sessionId: string, payload: Omit<TaskConfirmFrame, 'type' | 'session_id'>): void {
    if (!this.openTurn(sessionId)) return
    this.send({
      type: CLIENT_FRAME.TaskConfirm,
      session_id: sessionId,
      ...payload,
    })
  }

  /** Resume Plan with the complete outline edited in the presentation pane. */
  presentationOutlineConfirm(
    sessionId: string,
    payload: Omit<PresentationOutlineConfirmFrame, 'type' | 'session_id'>,
  ): void {
    if (!this.openTurn(sessionId)) return
    this.send({
      type: CLIENT_FRAME.PresentationOutlineConfirm,
      session_id: sessionId,
      ...payload,
    })
  }

  /** Save or cancel a Workflow Build and resume its parked HITL Turn. This is
   *  a dedicated command, not a chat block, so it never renders as user input. */
  workflowConfirm(
    sessionId: string,
    payload: Omit<WorkflowConfirmFrame, 'type' | 'session_id'>,
  ): void {
    if (!this.openTurn(sessionId)) return
    this.send({
      type: CLIENT_FRAME.WorkflowConfirm,
      session_id: sessionId,
      ...payload,
    })
  }

  /** Resume a parked permission turn with the user's per-call decisions. A
   *  dedicated WS command (not a chat block), so it never renders as user-authored
   *  input — the daemon resolves each verdict by `call_index` and resumes without
   *  producing a user message. Mirrors `workflowConfirm()`. */
  respondPermission(
    sessionId: string,
    payload: Omit<PermissionAnswerFrame, 'type' | 'session_id'>,
  ): void {
    if (!this.openTurn(sessionId)) return
    this.send({
      type: CLIENT_FRAME.PermissionAnswer,
      session_id: sessionId,
      ...payload,
    })
  }

  /** Resume a parked choice card with the selected option ids. A dedicated WS
   *  command (not a chat block), so it never renders as user-authored input —
   *  the daemon resolves each answer's `option_id` to its stable action and
   *  folds free-typed `text` back to the model. Mirrors `respondPermission()`. */
  choiceAnswer(
    sessionId: string,
    payload: Omit<ChoiceAnswerFrame, 'type' | 'session_id'>,
  ): void {
    if (!this.openTurn(sessionId)) return
    this.send({
      type: CLIENT_FRAME.ChoiceAnswer,
      session_id: sessionId,
      ...payload,
    })
  }

  // NOTE: a `human_request` reply typed directly into the composer still uses
  // chat(): it is regular user-authored input, and the daemon folds it back to
  // the model as a free-form (not_answered) reply. Banner picks are different:
  // they resume from a structured outcome via choiceAnswer().

  /** Stop button, local half: finalize the partial as stopped and absorb any
   *  residual frames. The REAL stop is the caller's `POST /sessions/{id}/stop`
   *  (see `cancelTurnAtom`) — the daemon cancels the agent task; frames may
   *  still race in until that lands, hence the `cancelled` marker. */
  cancel(sessionId: string): void {
    const t = this.turns.get(sessionId)
    if (!t || t.cancelled) return
    if (t.translator.started) {
      this.dispatch(sessionId, { type: 'message_stop', messageId: t.messageId })
    }
    this.dispatch(sessionId, { type: 'done', reason: 'cancelled', messageId: t.messageId })
    this.turns.set(sessionId, { ...t, cancelled: true })
  }

  /** Tear down the socket. `intentional` suppresses auto-reconnect (config
   *  change / HMR dispose). */
  close(intentional: boolean): void {
    this.intentionalClose = intentional
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const ws = this.ws
    this.ws = null
    this.phase = 'closed'
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close()
      } catch {
        // ignore — already closing
      }
    }
  }

  private connect(): void {
    if (!this.endpoint || !this.endpoint.token) return
    const endpoint = this.endpoint
    this.intentionalClose = false
    this.phase = 'connecting'
    const ws = this.socketFactory(toWsUrl(endpoint.baseUrl, endpoint.wsPath))
    this.ws = ws

    ws.onopen = (): void => {
      if (this.ws !== ws) return // endpoint was cleared/replaced while connecting
      const hello: HelloFrame = {
        type: CLIENT_FRAME.Hello,
        token: endpoint.token,
        client_type: 'gui',
        client_id: endpoint.clientId,
        // The handshake's Accept-Language is Chromium's OS-derived guess (the browser
        // WebSocket API won't let us set headers), so the daemon needs the user's actual
        // choice here or its display text drifts from the UI's.
        locale: i18n.resolvedLanguage ?? i18n.language,
      }
      ws.send(JSON.stringify(hello))
    }
    ws.onmessage = (ev: MessageEvent): void => {
      if (this.ws !== ws) return // ignore late frames from a superseded daemon
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as Record<string, unknown>
      } catch {
        return // ignore unparseable frames
      }
      if (frame && typeof frame === 'object') this.onFrame(frame)
    }
    ws.onclose = (ev: CloseEvent): void => {
      if (this.ws !== ws) return // superseded by a newer socket
      this.ws = null
      this.phase = 'closed'
      if (this.intentionalClose) return
      // Unexpected drop (daemon restart / network): the daemon won't resume
      // in-flight turns, so fail them rather than leave the UI spinning.
      this.failAllActiveTurns(i18n.t('error.connectionClosed', { code: ev.code }))
      if (NO_RETRY_CLOSE_CODES.has(ev.code)) {
        // The handshake never reached Ready, so queued mutations have not been
        // accepted. Never carry them into a later auth/protocol recovery.
        this.discardOutbox()
        if (ev.code === 4401) this.notifyAuthFailure()
        // Auth (4401) / protocol (1002) failure — the same token + hello would
        // be rejected on every retry. Stop auto-reconnect; recovery is the main
        // process broadcasting a fresh endpoint (→ configure → new key → connect).
        rlog.warn('[ws-conn] terminal close, auto-reconnect disabled', { code: ev.code })
        return
      }
      this.scheduleReconnect()
    }
    ws.onerror = (): void => {
      // onclose follows; reconnect is handled there to avoid double-scheduling.
      rlog.warn('[ws-conn] socket error')
    }
  }

  private onFrame(frame: Record<string, unknown>): void {
    const type = typeof frame['type'] === 'string' ? (frame['type'] as string) : undefined
    if (!type) return

    switch (type) {
      case CONTROL_FRAME.Ready:
        this.phase = 'ready'
        this.retryMs = RETRY_BASE_MS
        this.onReady()
        return
      case CONTROL_FRAME.Ack:
        return // handshake noise; daemon attaches the relay synchronously
      case CONTROL_FRAME.CmdError: {
        let sid = typeof frame['session_id'] === 'string' ? (frame['session_id'] as string) : undefined
        const command = typeof frame['for'] === 'string' ? frame['for'] : undefined
        // Older daemons omitted session_id when schema validation failed.
        // Structured interaction commands open exactly one local turn in the
        // usual desktop flow, so recover that owner instead of leaving an
        // immortal "generating" reply.
        if (
          !sid &&
          command &&
          command !== CLIENT_FRAME.Subscribe &&
          command !== CLIENT_FRAME.Unsubscribe &&
          command !== CLIENT_FRAME.Hello &&
          this.turns.size === 1
        ) {
          sid = this.turns.keys().next().value as string | undefined
        }
        const message =
          typeof frame['message'] === 'string' ? (frame['message'] as string) : i18n.t('error.commandFailed')
        if (sid) {
          this.turns.delete(sid)
          this.dispatch(sid, { type: 'stream_discard' })
          this.dispatch(sid, { type: 'command_error', message })
        }
        else rlog.warn('[ws-conn] cmd_error without session_id', { message })
        return
      }
      case CONTROL_FRAME.Shutdown:
        this.failAllActiveTurns(i18n.t('error.daemonShuttingDown'))
        return
      case CONTROL_FRAME.SessionCompleted: {
        // Cross-session broadcast: a session's turn finished. Mark it unread
        // (the sidebar dot) for ANY session, not just one with a live turn here.
        const sid = typeof frame['session_id'] === 'string' ? (frame['session_id'] as string) : undefined
        if (sid) this.dispatch(sid, { type: 'session_completed' })
        return
      }
      case CONTROL_FRAME.SubAgentEvent: {
        const parsed = subAgentEventSchema.safeParse(frame)
        if (!parsed.success) {
          rlog.warn('[ws-conn] subagent.event payload invalid', parsed.error)
          return
        }
        const event = parsed.data
        if (!this.retainChildSubscription(event.session_id, event.invocation_id)) return
        this.dispatch(event.session_id, {
          type: 'subagent_event',
          invocationId: event.invocation_id,
          parentToolCallId: event.parent_tool_call_id ?? undefined,
          mode: event.mode,
          goal: event.goal,
          status: event.status,
          phase: event.phase,
          answer: event.answer ?? undefined,
          error: event.error ?? undefined,
        })
        return
      }
      case CONTROL_FRAME.ScheduleNotify: {
        // Global side effect, not per-session turn state — goes to main over
        // IPC (native toast), NOT through this.dispatch. The daemon only sends
        // this when a gui client is subscribed; if we drop it here nobody else
        // will notify, hence the warn on invalid/failed paths.
        const parsed = scheduleNotifySchema.safeParse(frame)
        if (!parsed.success) {
          rlog.warn('[ws-conn] schedule.notify payload invalid', parsed.error)
          return
        }
        const p = parsed.data
        // Optional chaining: bun:test has no `window`; apiStub covers Playwright.
        void globalThis.window?.api?.notify
          ?.show({
            title: p.title,
            body: p.body,
            sessionId: p.session_id,
            scheduleId: p.schedule_id,
            kind: p.kind,
          })
          .then((r) => {
            if (!r.shown) rlog.warn('[ws-conn] schedule.notify not shown (unsupported platform)', { kind: p.kind })
          })
          .catch((err) => rlog.warn('[ws-conn] schedule.notify IPC failed', err))
        return
      }
      default: {
        // Turn event: demux by session_id into that session's translator.
        const sid = typeof frame['session_id'] === 'string' ? (frame['session_id'] as string) : undefined
        if (!sid) return
        const data: Record<string, unknown> = { ...frame }
        delete data['type']
        delete data['session_id']
        let t = this.turns.get(sid)
        if (!t) {
          if (!this.subscribed.has(sid)) return
          // `title` is session-level metadata, not a turn. It now arrives AFTER
          // `final` (title generation runs off the turn's critical path), so there's
          // no active turn — DON'T spin up a new one (that renders a phantom loading
          // bubble + never-ending "stop" state). Translate + dispatch it standalone.
          if (type === TURN_EVENT.Title) {
            const meta = translateTurnEvent(
              { event: type, data } as TurnEvent,
              '',
              { ...initialTranslatorState, started: true },
            )
            for (const out of meta.events) this.dispatch(sid, out)
            return
          }
          t = this.createTurn(sid)
        }
        const terminal =
          type === TURN_EVENT.Final ||
          type === TURN_EVENT.Cancelled ||
          type === TURN_EVENT.Error
        if (t.cancelled) {
          // Absorb residual frames after a local cancel until the turn ends.
          if (terminal) this.turns.delete(sid)
          return
        }
        const r = translateTurnEvent({ event: type, data } as TurnEvent, t.messageId, t.translator)
        t.translator = r.state
        if (r.warning) rlog.warn(`[ws-conn] ${r.warning}`, { sessionId: sid })
        for (const out of r.events) this.dispatch(sid, out)
        if (terminal) this.turns.delete(sid)
      }
    }
  }

  /** After the handshake: re-subscribe every known topic (a reconnected daemon
   *  has none), THEN flush queued chat frames — order matters (subscribe before
   *  chat). */
  private onReady(): void {
    for (const sid of this.subscribed) {
      this.rawSend({ type: CLIENT_FRAME.Subscribe, topics: [sessionTopic(sid)] })
    }
    this.rawSend({ type: CLIENT_FRAME.Subscribe, topics: [SYSTEM_TOPIC] })
    const pending = this.outbox
    this.outbox = []
    for (const item of pending) {
      // Defence in depth: configure() clears on replacement, and the key check
      // keeps an old command from flushing if another close path is added later.
      if (item.endpointKey === this.endpointKey) this.rawSend(item.frame)
    }
    this.readyHandler()
  }

  subscribe(sessionId: string): void {
    if (this.releasedSessions.has(sessionId) || this.subscribed.has(sessionId)) return
    this.subscribed.add(sessionId)
    // When ready, subscribe now; otherwise `onReady` subscribes the whole set.
    if (this.phase === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
      this.rawSend({ type: CLIENT_FRAME.Subscribe, topics: [sessionTopic(sessionId)] })
    }
  }

  private retainChildSubscription(parentSessionId: string, childSessionId: string): boolean {
    if (this.releasedSessions.has(parentSessionId)) return false
    this.childParents.set(childSessionId, parentSessionId)
    this.subscribe(childSessionId)
    return true
  }

  private openTurn(sessionId: string): boolean {
    if (this.turns.has(sessionId)) {
      this.dispatch(sessionId, {
        type: 'command_error',
        message: i18n.t('error.responseStillGenerating'),
      })
      return false
    }
    this.subscribe(sessionId)
    this.createTurn(sessionId)
    return true
  }

  private createTurn(sessionId: string): TurnState {
    const messageId = `a-${crypto.randomUUID()}`
    const state = {
      // Pre-mark `started` so the daemon's first frame does NOT re-inject
      // message_start — we emit it optimistically just below. Threading the
      // pre-started state here keeps translateTurnEvent pure + cancel()'s
      // `started` check correct (Stop before first token still finalizes).
      messageId,
      translator: { ...initialTranslatorState, started: true },
      cancelled: false,
    }
    this.turns.set(sessionId, state)
    // Open the assistant turn NOW — before the first daemon frame — so the UI
    // shows a loading indicator during the first-token gap.
    this.dispatch(sessionId, { type: 'message_start', messageId, role: 'assistant' })
    return state
  }

  /** Detach one Session topic without destroying its local Turn projection. */
  unsubscribe(sessionId: string): void {
    if (!this.subscribed.delete(sessionId)) return
    const topic = sessionTopic(sessionId)
    if (this.phase === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
      this.rawSend({ type: CLIENT_FRAME.Unsubscribe, topics: [topic] })
    }
  }

  /** Explicitly destroy a Session topic tree and all transient local streams. */
  releaseSessionTree(sessionId: string): void {
    const pending = [sessionId]
    const released = new Set<string>()
    while (pending.length > 0) {
      const current = pending.pop()
      if (!current || released.has(current)) continue
      released.add(current)
      for (const [childId, parentId] of this.childParents) {
        if (parentId === current) pending.push(childId)
      }
    }
    for (const current of released) {
      this.releasedSessions.add(current)
      this.unsubscribe(current)
      if (this.turns.delete(current)) this.dispatch(current, { type: 'stream_discard' })
      this.childParents.delete(current)
    }
  }

  private send(frame: ClientFrame): void {
    if (this.phase === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
      this.rawSend(frame)
    } else {
      this.outbox.push({ endpointKey: this.endpointKey, frame })
    }
  }

  private discardOutbox(): void {
    this.outbox = []
  }

  private notifyAuthFailure(): void {
    if (!this.endpointKey) return
    const now = Date.now()
    if (
      this.lastAuthFailure?.endpointKey === this.endpointKey &&
      now - this.lastAuthFailure.at < AUTH_FAILURE_THROTTLE_MS
    ) {
      return
    }
    this.lastAuthFailure = { endpointKey: this.endpointKey, at: now }
    try {
      this.authFailureHandler({ code: 4401 })
    } catch (err) {
      rlog.warn('[ws-conn] auth failure callback threw', err)
    }
  }

  private rawSend(frame: ClientFrame): void {
    try {
      this.ws?.send(JSON.stringify(frame))
    } catch (err) {
      rlog.error('[ws-conn] send failed', err)
    }
  }

  /** Fail every started, non-cancelled in-flight turn with an error event
   *  (the reducer finalizes the partial as errored), then clear the turn map.
   *  `subscribed` is kept for the reconnect's re-subscribe. */
  private failAllActiveTurns(message: string): void {
    for (const [sid, t] of this.turns) {
      if (!t.cancelled && t.translator.started) {
        this.dispatch(sid, { type: 'error', message })
      }
    }
    this.turns.clear()
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.retryTimer) return
    const delay = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }
}

let _instance: AmphiWsConnection | null = null

/** The process-wide chat connection singleton (lazily created). */
export function getAmphiWsConnection(): AmphiWsConnection {
  if (!_instance) _instance = new AmphiWsConnection()
  return _instance
}

// HMR: drop the old socket so dev reloads don't accumulate ghost connections.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _instance?.close(true)
    _instance = null
  })
}
