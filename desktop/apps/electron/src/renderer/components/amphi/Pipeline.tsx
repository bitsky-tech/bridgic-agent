/**
 * Build pipeline view — center column when a session is active.
 *
 * Layout: scrolling message list. The input bar is NOT here — composer
 * (`ChatInputZone`) is rendered as a sibling in `App.tsx`.
 *
 * Data flow (Task 5+):
 *   currentMessagesAtom  → live messages for the active session
 *   currentStreamingAtom → in-flight assistant streaming state (or undefined)
 *   useSmoothStream      → reveals streaming text at ~180 chars/s for
 *                          smoother visual; raw text bypasses smoothing
 *                          when lag exceeds 200 chars (avoid death spiral).
 *
 * The legacy `messages` prop is kept as a fallback for cases where atoms
 * are not in scope (kept tiny — no app code uses it now).
 *
 * Refactored to Tailwind className per §1.22.
 */

import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { messageActionText } from '@/lib/messageActions'
import { openIssueReportAtom, type IssueReportThinkingSnapshot } from '@/atoms/issue-report'
import { activeModelAtom } from '@/atoms/models'
import { executionModeAtom } from '@/atoms/permissions'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { BridgicLogo } from './Primitives'
import { MessageActionBar } from './MessageActionBar'
import {
  INITIAL_SCROLL_INTENT,
  MIN_SCROLLABLE_DISTANCE,
  nextScrollIntent,
  ScrollControls,
  type ScrollIntentState,
} from './ScrollControls'
import {
  currentMessagesAtom,
  currentStreamingAtom,
  currentThinkingModeAtom,
  fetchOlderTranscriptAtom,
  hydratedSessionIdsAtom,
  isBrowserAgentActionToolName,
  transcriptPagingFamily,
  type AgentMessage,
  type AgentMessageToolCall,
  type MessageBlock,
  type StreamingState,
} from '@/atoms/agent'
import { useSmoothStream } from '@/hooks/useSmoothStream'
import { useInfiniteScrollSentinel } from '@/hooks/useInfiniteScrollSentinel'
import { useAutoHideScrollbar } from '@/hooks/useAutoHideScrollbar'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { LocalPathText } from '@/components/markdown/LocalResourceView'
import { MessageThinking } from './MessageThinking'
import { MessageToolCall } from './MessageToolCall'
import { MessageContent } from './MessageContent'
import { Icons } from './Icons'
import { StructuredInput } from './StructuredInput'
import { isParentWaitingForSubagents, subagentsAtom } from '@/atoms/subagents'
import { pendingBySessionAtom } from '@/atoms/human-request'

export type MessageRole = 'ai' | 'user'
export type MessageType = 'text'

/** Newest rows mounted per window step — chosen against the render baseline
 *  (~31.5 DOM nodes per realistic turn: 100 rows ≈ 3.2k nodes, negligible). */
export const MESSAGE_TAIL_CHUNK = 100

export interface Message {
  role: MessageRole
  content: string
  type?: MessageType
  /** Stable id for keyed rendering. */
  messageId?: string
  /** Durable identity shared by the user input and its Assistant reply. */
  turnId?: string
  /** Execution configuration captured for this durable Turn. */
  model?: string
  executionMode?: AgentMessage['executionMode']
  /** Assistant chain of thought (reasoning); only used as a flat fallback for old messages without blocks. */
  thinking?: string
  /** Assistant tool calls; only used as a flat fallback for old messages without blocks. */
  toolCalls?: AgentMessageToolCall[]
  /** Ordered content blocks (preferred): when non-empty, text/thinking/tool are interleaved in their real order. */
  blocks?: MessageBlock[]
  /** This bubble is an in-flight streaming turn. Combined with empty blocks → render the loading dots before the first token. */
  streaming?: boolean
  /** The current model connection is doing a backoff retry; only present on a streaming Turn, never persisted. */
  retry?: StreamingState['retry']
  /** Error message for a turn that failed; when non-empty a red error bar is rendered after the body (WS error / gateway not ready, etc.). */
  error?: string
  /** The backend's authoritative final answer (only available once the turn ends); passed through to MessageContent to split process/answer precisely. */
  finalAnswer?: string | null
  /** Durable backend state for a logical Turn parked on blocking Child Agents. */
  turnStatus?: AgentMessage['turnStatus']
  /** The user stopped this round of generation on purpose. */
  stopped?: boolean
  completedAt?: number | null
  durationMs?: number | null
  /** In-flight turn start time used by the live elapsed-time indicator. */
  startedAt?: number
  /** Session owning interactive blocks such as permission approval. */
  sessionId?: string
  /** This is the latest Agent reply parked on an external human-request card. */
  waitingForHumanRequest?: boolean
}

export interface PipelineProps {
  /** Legacy fallback — Task 5+ reads `currentMessagesAtom` when present. */
  messages?: Message[]
  /** Explicit Session source used by embedded conversation views. */
  session?: {
    id: string
    messages: AgentMessage[]
    streaming?: StreamingState
    pending: boolean
    emptyText?: string
  }
  /** Message actions belong to the primary conversation, not embedded transcripts. */
  enableMessageActions?: boolean
}

export function Pipeline({ messages: legacyMessages, session, enableMessageActions }: PipelineProps) {
  const { t } = useTranslation()
  // Read live messages + streaming state from atoms. Fall back to the
  // legacy `messages` prop only when both are empty (preserves backward
  // compat for any test/storyboard that still passes static messages).
  const activeMessages = useAtomValue(currentMessagesAtom)
  const activeStreaming = useAtomValue(currentStreamingAtom)
  const liveMessages = session ? session.messages : activeMessages
  const streamingState = session ? session.streaming : activeStreaming
  const messages: Message[] =
    liveMessages.length > 0 || streamingState || session
      ? liveMessages.map(toAmphiMessage)
      : (legacyMessages ?? [])
  const smoothStreamingText = useSmoothStream(streamingState?.content)

  // Auto-scroll: a stick-to-bottom state machine with **direction awareness** (v3 — the lesson from v2:
  // the stick=false set by wheel-up got overwritten back to true by the scroll event that follows the
  // same gesture, whose direction-less check said "still within the 80px band", producing resistance
  // that kept dragging the view down while the user scrolled up).
  //   - the user scrolls **up** (scrollTop decreases, by any input method): unconditionally leave
  //     follow mode, with no band check — an upward intent absolutely outranks the downward scroll of
  //     streaming output.
  //   - the user scrolls **down / stays put**: being back within 80px of the bottom = follow again; the
  //     80px tolerance absorbs streaming growth / layout jitter (strict bottom-sticking is broken by a
  //     growth race).
  //   - programmatic scroll to bottom: skipped when already at the bottom (otherwise the flag leaks
  //     with no scroll echo and swallows the next user event); consuming the echo also syncs the
  //     lastScrollTop direction baseline.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useAutoHideScrollbar(scrollRef)
  const stickRef = useRef(true)
  const programmaticRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  // Floating scroll button: hidden by default, fades in while scrolling (when the content is long
  // enough) and fades out after a moment of idling. The direction comes from nextScrollIntent based on
  // "accumulated displacement in the same direction", with the accumulator kept in a ref (it changes on
  // every scroll, and putting it in state would trigger re-renders for nothing); only the final
  // direction is lifted into state to drive rendering.
  // Switching sessions deliberately does not reset these two: A2 scrolls the new session to the bottom,
  // and the first scroll event hits the "at the bottom" boundary check and converges to "back to top"
  // automatically, without an extra effect-setState.
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [scrollDirection, setScrollDirection] = useState(INITIAL_SCROLL_INTENT.direction)
  const scrollIntentRef = useRef<ScrollIntentState>(INITIAL_SCROLL_INTENT)
  const hideScrollBtnRef = useRef<number | null>(null)
  const messageCount = messages.length
  // Streaming growth signature: it tracks the total content of **every block** in the streaming bubble
  // (thinking / intermediate body / tools) rather than just the answer body (streamingState.content),
  // otherwise the thinking/tool phases would not trigger A1's follow-to-bottom.
  const streamingSig = streamingState
    ? streamingState.blocks.reduce(
        (n, b) => n + (b.type === 'text' || b.type === 'thinking' ? b.text.length : 1),
        0,
      )
    : 0
  // The streaming bubble (loading dots / output in progress) is rendered separately and not counted in
  // messages — its mount/unmount must trigger scrolling independently, otherwise after sending, the
  // loading bubble sits outside the viewport (user feedback).
  const streamingActive = streamingState !== undefined
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const activeModel = useAtomValue(activeModelAtom)
  const currentExecutionMode = useAtomValue(executionModeAtom)
  const currentThinkingMode = useAtomValue(currentThinkingModeAtom)
  const ownerSessionId = session?.id ?? activeSessionId ?? undefined
  const messageActionsEnabled =
    enableMessageActions ?? (session === undefined && legacyMessages === undefined)
  const pendingRequests = useAtomValue(pendingBySessionAtom)
  const waitingForHumanRequest = ownerSessionId ? pendingRequests.has(ownerSessionId) : false
  const latestAssistantIndex = messages.findLastIndex((message) => message.role === 'ai')
  const pairedUsersByAssistantIndex = new Map<number, Message>()
  const usersByTurnId = new Map<string, Message>()
  let latestUserMessage: Message | undefined
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      latestUserMessage = message
      if (message.turnId) usersByTurnId.set(message.turnId, message)
      return
    }
    const pairedUser =
      (message.turnId ? usersByTurnId.get(message.turnId) : undefined) ?? latestUserMessage
    if (pairedUser) pairedUsersByAssistantIndex.set(index, pairedUser)
  })
  // The instant a session is switched the transcript is still loading asynchronously
  // (loadSessionMessages, 5~50ms + network) and messages is briefly [] — the "start this session" empty
  // state must not be rendered during that window (it would flash). hydratedIds is marked when the
  // transcript finishes loading (including an empty transcript), which distinguishes "loading" from "a
  // genuinely empty session".
  const hydratedIds = useAtomValue(hydratedSessionIdsAtom)
  const transcriptPending = session
    ? session.pending
    : activeSessionId != null && !hydratedIds.has(activeSessionId)

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const target = el.scrollHeight - el.clientHeight
    if (Math.abs(el.scrollTop - target) < 1) return
    programmaticRef.current = true
    el.scrollTop = target
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // Floating scroll button: there was scrolling and the content is long enough → show it and reset the
    // idle fade-out timer; the content is too short for jumping to mean anything → hide immediately. The
    // direction flips according to the accumulated intent (at the top it only points down, at the bottom
    // only up).
    // This runs before the early return of the stick logic below; when the value does not change React
    // skips the re-render.
    const intent = nextScrollIntent(scrollIntentRef.current, el)
    scrollIntentRef.current = intent
    setScrollDirection(intent.direction)
    if (el.scrollHeight - el.clientHeight > MIN_SCROLLABLE_DISTANCE) {
      setShowScrollBtn(true)
      if (hideScrollBtnRef.current) window.clearTimeout(hideScrollBtnRef.current)
      hideScrollBtnRef.current = window.setTimeout(() => setShowScrollBtn(false), 1500)
    } else {
      setShowScrollBtn(false)
      if (hideScrollBtnRef.current) window.clearTimeout(hideScrollBtnRef.current)
    }
    if (programmaticRef.current) {
      programmaticRef.current = false
      lastScrollTopRef.current = el.scrollTop
      return
    }
    const goingUp = el.scrollTop < lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    if (goingUp) {
      stickRef.current = false
      return
    }
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80
  }, [])

  // Effect A1: on content change (message count / streaming block growth / streaming bubble mount),
  // scroll to the bottom only while in follow mode. It depends on streamingSig (the content volume of
  // every block), so growth in thinking / tools / answer all trigger the follow.
  useEffect(() => {
    if (!stickRef.current) return
    scrollToBottom()
  }, [messageCount, streamingSig, streamingActive, scrollToBottom])

  // Effect A2: switching sessions → return to follow mode and go to the bottom (opening a session shows
  // the latest messages). When the asynchronously loaded history (5~50ms) lands, A1 performs the actual
  // scroll; the immediate scroll here covers the corner case where the message count happens to be
  // identical and A1 does not fire.
  useEffect(() => {
    stickRef.current = true
    scrollToBottom()
  }, [ownerSessionId, scrollToBottom])

  // Effect A3: layout changes such as the stage header or the sidebar change the size of the message area; follow mode keeps it anchored to the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickRef.current) scrollToBottom()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [scrollToBottom])

  // Effect A4: the user sends (a user message is appended at the end) → unconditionally back to the
  // bottom. A message sent while the user is scrolled up reading must be immediately visible too —
  // that is the explicit intent of the send action and outranks the reading-back state.
  // A user message can only appear at the end of the list by being sent, so "the trailing user message
  // id changed" means a send.
  // Scroll once immediately + recalibrate once more with a double-rAF: after the user bubble renders
  // there is a second layout pass (line wrapping / markdown growing it), and the agent's loading bubble
  // only mounts a few frames later (that part is picked up by A1's streamingActive dependency).
  // Tail window: a big transcript mounts only its newest MESSAGE_TAIL_CHUNK
  // rows (measured: a realistic 1000-turn transcript is ~31.5k DOM nodes /
  // ~700ms when mounted whole — see list-perf-baseline.test.tsx). `hidden` is
  // the count of rows suppressed ABOVE the window; a top sentinel reveals one
  // more chunk per hit. The window GROWS on new tail messages instead of
  // sliding (hidden stays fixed), so a reader parked mid-history never has the
  // row above their viewport silently unmounted; it re-anchors only on session
  // switch. State is adjusted during render (React's prev-state pattern)
  // because the transcript hydrates asynchronously after a switch — the
  // window must apply the moment rows land, not an effect-tick later.
  // initAtCount = the message count when the window was initialised (0 = not initialised). The third
  // branch handles sessions where "WS pushed 1-2 messages first and the REST transcript landed
  // wholesale afterwards": the window was initialised at 1-2 messages (hidden=0), and once the bulk
  // transcript arrives it has to be tightened again, otherwise that session stays fully mounted forever.
  // A one-shot upgrade: after re-initialisation initAtCount grows, the guard closes itself, and it
  // cannot ping-pong with the upward prepend paging (which happens once hidden > 0 or while paging).
  const [tailWindow, setTailWindow] = useState(() => ({
    sessionId: ownerSessionId,
    hidden: Math.max(0, messages.length - MESSAGE_TAIL_CHUNK),
    initAtCount: messages.length,
  }))
  if (
    tailWindow.sessionId !== ownerSessionId ||
    (tailWindow.initAtCount === 0 && messages.length > 0) ||
    (tailWindow.initAtCount <= 2 && messages.length > MESSAGE_TAIL_CHUNK)
  ) {
    setTailWindow({
      sessionId: ownerSessionId,
      hidden: Math.max(0, messages.length - MESSAGE_TAIL_CHUNK),
      initAtCount: messages.length,
    })
  }
  // A shrunken transcript (reset/clear) can leave `hidden` past the end —
  // fall back to showing everything rather than an empty list.
  const hiddenCount = tailWindow.hidden >= messages.length ? 0 : tailWindow.hidden
  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages

  // The enter animation belongs to a message appearing, not to a bubble mounting. The two
  // come apart on every turn: the streaming bubble is a separate element from the message
  // it becomes, so finalising a reply unmounts one and mounts the other, and each replay
  // of the 150ms fade reads as the transcript flickering. Ids already rendered once are
  // recorded here and never animate again — including the streaming id, so the bubble the
  // user has been watching stays put when it settles.
  // Held in state rather than a ref purely so it can be read during render (a ref cannot;
  // react-hooks/refs). Nothing subscribes to it — the Set is mutated in place from the
  // effect below and never replaces the state, so recording an id triggers no re-render.
  const [animatedIds] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    for (const message of visibleMessages) {
      if (message.messageId) animatedIds.add(message.messageId)
    }
    if (streamingState?.messageId) animatedIds.add(streamingState.messageId)
  })

  // Revealing older rows prepends content: keep the viewport anchored by
  // preserving distance-from-bottom (scrollHeight - scrollTop) across the
  // commit. The write goes through the programmatic-scroll echo protocol so
  // the direction tracker doesn't misread it as user scrolling.
  // When the server still has earlier cursor pages, the sentinel switches to fetching remote
  // history once the in-memory window is exhausted.
  // Only the active session (the atom data source) paginates; the embedded view driven by the `session`
  // prop already carries the complete messages.
  const paging = useAtomValue(transcriptPagingFamily(ownerSessionId ?? '__none__'))
  const fetchOlder = useSetAtom(fetchOlderTranscriptAtom)
  const serverHasMore = !session && ownerSessionId != null && paging.hasMore

  const pendingAnchorRef = useRef<number | null>(null)
  // useInfiniteScrollSentinel reads the latest callback through a ref internally, so a dependency change does not remount the observer.
  const revealOlderMessages = useCallback(() => {
    const el = scrollRef.current
    pendingAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null
    if (hiddenCount > 0) {
      setTailWindow((state) => ({
        ...state,
        hidden: Math.max(0, state.hidden - MESSAGE_TAIL_CHUNK),
      }))
      return
    }
    if (serverHasMore && ownerSessionId) {
      // If nothing was actually prepended (in-flight dedupe / no more / network failure) clear the anchor —
      // a leftover anchor would be consumed by mistake by a later, unrelated tail append and yank the
      // reader's viewport away.
      void fetchOlder(ownerSessionId).then((prepended) => {
        if (!prepended) pendingAnchorRef.current = null
      })
    } else {
      pendingAnchorRef.current = null
    }
  }, [hiddenCount, serverHasMore, ownerSessionId, fetchOlder])
  const topSentinelRef = useInfiniteScrollSentinel(
    revealOlderMessages,
    hiddenCount > 0 || serverHasMore,
  )
  useLayoutEffect(() => {
    if (pendingAnchorRef.current == null) return
    const el = scrollRef.current
    if (el) {
      programmaticRef.current = true
      el.scrollTop = el.scrollHeight - pendingAnchorRef.current
    }
    pendingAnchorRef.current = null
  }, [hiddenCount, messageCount])

  const lastMessage = messages[messages.length - 1]
  const lastUserMessageId =
    lastMessage?.role === 'user' ? (lastMessage.messageId ?? null) : null
  const prevLastUserIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!lastUserMessageId || lastUserMessageId === prevLastUserIdRef.current) return
    prevLastUserIdRef.current = lastUserMessageId
    stickRef.current = true
    scrollToBottom()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom()
      })
    })
  }, [lastUserMessageId, scrollToBottom])

  // Clear the scroll button's fade-out timer on unmount to prevent setState-on-unmounted.
  useEffect(
    () => () => {
      if (hideScrollBtnRef.current) window.clearTimeout(hideScrollBtnRef.current)
    },
    [],
  )

  return (
    // The 5-stage indicator bar at the top has been removed; the middle area of the session view is now
    // just the scrolling message list. The outer layout is a flex column and the message area uses flex-1
    // to fill the parent's height. relative provides the positioning anchor for the scroll button.
    <div className="relative h-full overflow-hidden flex flex-col">
      {/* Messages — `min-h-0` lets the flex item really shrink to the available height; `[&>*]:shrink-0`
          — flex children default to flex-shrink:1, so when the total content height exceeds the container
          the flex algorithm squashes the last child down to a few pixels (combined with Card's own
          overflow-hidden that makes the content disappear entirely); forcing shrink-0 on every direct
          child preserves their intrinsic height and lets overflow-auto handle the overflow by scrolling. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        aria-label={t('session.pipeline.messagesAria')}
        className="auto-hide-scrollbar min-h-0 flex-1 overflow-auto px-6 py-5 flex flex-col gap-4 [&>*]:shrink-0"
      >
        {messages.length === 0 && !streamingState ? (
          <EmptyTranscript pending={transcriptPending} text={session?.emptyText} />
        ) : (
          <>
            {(hiddenCount > 0 || serverHasMore) && (
              <div
                ref={topSentinelRef}
                className="px-2 py-[5px] text-center text-[10px] text-text-tertiary"
              >
                {hiddenCount > 0
                  ? t('session.pipeline.loadEarlierWithCount', { n: hiddenCount })
                  : t('session.pipeline.loadEarlier')}
              </div>
            )}
            {/* The streaming reply is the LAST ITEM OF THIS SAME ARRAY, keyed by the message
                id the daemon already assigned it — the very id the finalised message carries
                (`done` reuses event.messageId). Rendering it as a sibling after the array instead
                would put it in a different child slot, so settling a reply unmounts one element and
                mounts another: the bubble's DOM is rebuilt, `:hover` is recomputed, and the action
                row underneath blinks through its 150ms opacity transition. Same array + same key =
                React updates the node in place. */}
            {[...visibleMessages.map((m, i) => {
              const messageIndex = hiddenCount + i
              const useLiveConfiguration =
                m.role === 'ai' && !m.turnId && messageIndex === latestAssistantIndex
              const reportModel = m.model ?? (useLiveConfiguration ? activeModel?.modelId : undefined)
              return (
                <MessageBubble
                  key={m.messageId ?? messageIndex}
                  {...m}
                  animateEnter={!m.messageId || !animatedIds.has(m.messageId)}
                  sessionId={ownerSessionId}
                  enableActions={messageActionsEnabled}
                  relatedUserMessage={pairedUsersByAssistantIndex.get(messageIndex)}
                  model={reportModel}
                  executionMode={m.executionMode ?? (useLiveConfiguration ? currentExecutionMode : undefined)}
                  reportThinking={
                    m.role === 'ai' && messageIndex === latestAssistantIndex
                      ? currentThinkingMode ?? undefined
                      : undefined
                  }
                  reportProviderId={
                    activeModel && reportModel === activeModel.modelId
                      ? activeModel.providerId
                      : undefined
                  }
                  // `latestAssistantIndex` indexes the FULL transcript — offset
                  // the sliced index back into full-array space before comparing.
                  waitingForHumanRequest={
                    waitingForHumanRequest && messageIndex === latestAssistantIndex
                  }
                />
              )
            }), ...(streamingState ? [
              <MessageBubble
                key={streamingState.messageId}
                role="ai"
                content={smoothStreamingText}
                type="text"
                messageId={streamingState.messageId}
                animateEnter={!animatedIds.has(streamingState.messageId)}
                blocks={streamingState.blocks}
                sessionId={ownerSessionId}
                streaming
                retry={streamingState.retry}
                startedAt={streamingState.startedAt}
              />,
            ] : [])]}
          </>
        )}
      </div>
      <ScrollControls scrollRef={scrollRef} visible={showScrollBtn} direction={scrollDirection} />
    </div>
  )
}

/**
 * Empty message area: while the transcript is still loading, render blank (so the "start this session"
 * hint does not flash); the opening hint is only shown once loading has finished and there really are
 * no messages (a blank screen would make the user think the page is broken).
 */
function EmptyTranscript({ pending, text }: { pending: boolean; text?: string }) {
  const { t } = useTranslation()
  if (pending) return null
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-text-tertiary">
      {text ?? t('session.pipeline.defaultEmpty')}
    </div>
  )
}

/**
 * Map an AgentMessage (atoms/agent) to the Pipeline-shaped Message.
 *
 * Assistant text is rendered as Markdown by `MessageBubble`; user text stays
 * plain to preserve literal input.
 */
function toAmphiMessage(m: AgentMessage): Message {
  return {
    role: m.role === 'user' ? 'user' : 'ai',
    content: m.text,
    type: 'text',
    messageId: m.id,
    turnId: m.turnId,
    model: m.model,
    executionMode: m.executionMode,
    thinking: m.thinking,
    toolCalls: m.toolCalls,
    blocks: m.blocks,
    error: m.error,
    finalAnswer: m.finalAnswer,
    turnStatus: m.turnStatus,
    stopped: m.stopped,
    completedAt: m.completedAt,
    durationMs: m.durationMs,
  }
}

/* ─── Subcomponents ─── */

/** Render a user message's structured blocks: plain text runs interleaved with
 *  mention / slash badges (rebuilds the composer's inline tokens on replay /
 *  optimistic send). Token styling + prefix (`@` for files, `/` for capability references, getMentionPrefix)
 *  mirrors `composer/segments.ts :: segmentsToHtml`. */
function UserMessageBlocks({ blocks }: { blocks: MessageBlock[] }) {
  return (
    <div className="text-base leading-[1.65] text-text-primary">
      <StructuredInput blocks={blocks} />
    </div>
  )
}

interface TextMessageBodyProps {
  isUser: boolean
  content: string
  blocks?: MessageBlock[]
  streaming?: boolean
  thinking?: string
  toolCalls?: AgentMessageToolCall[]
  finalAnswer?: string | null
  sessionId?: string
  waitingForSubagent?: boolean
  waitingForHumanRequest?: boolean
}

/** Body renderer for a `type: 'text'` bubble — picks user/assistant layout and,
 *  for assistant, ordered-blocks vs streaming-dots vs flat legacy fallback. */
function TextMessageBody({
  isUser,
  content,
  blocks,
  streaming,
  thinking,
  toolCalls,
  finalAnswer,
  sessionId,
  waitingForSubagent,
  waitingForHumanRequest,
}: TextMessageBodyProps) {
  const hasBlocks = blocks !== undefined && blocks.length > 0
  if (isUser) {
    // User input: when there are structured blocks (@ / command badges) render per block, otherwise fall
    // back to plain text (markdown syntax is kept verbatim, not rendered).
    if (hasBlocks) return <UserMessageBlocks blocks={blocks} />
    return (
      <div className="text-base text-text-primary leading-[1.65] whitespace-pre-wrap break-words">
        <LocalPathText text={content} />
      </div>
    )
  }
  // assistant: ordered blocks → a process container + the answer outside it (QA revision H). While
  // streaming, `streaming` is passed through so the process container is force-expanded and visible
  // live; once finalised it is collapsed by default.
  if (hasBlocks) {
    return (
      <MessageContent
        blocks={blocks}
        streaming={streaming}
        finalAnswer={finalAnswer}
        sessionId={sessionId}
        waitingForSubagent={waitingForSubagent}
        waitingForHumanRequest={waitingForHumanRequest}
      />
    )
  }
  // The run status of a streaming Turn is rendered uniformly by MessageBubble.
  if (streaming) return null
  // Fallback (old persisted messages without blocks): flat rendering of the thinking block + tool list + body.
  return (
    <>
      {thinking && <MessageThinking thinking={thinking} />}
      {toolCalls && toolCalls.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-1.5">
          {toolCalls.map((tc) => (
            <MessageToolCall key={tc.toolUseId} call={tc} />
          ))}
        </div>
      )}
      <MarkdownMessage content={content} className="text-base leading-[1.65]" />
    </>
  )
}

/** Red error bar rendered after the body of a failed turn. `whitespace-pre-wrap` preserves the
 *  newlines in the backend's error message (a stack, "For more information check: …"), and
 *  `break-words` keeps a long URL from bursting the bubble. */
function MessageError({ message }: { message: string }) {
  return (
    <div className="mt-1.5 rounded-md bg-status-error-bg px-3 py-2 text-sm leading-relaxed text-status-error whitespace-pre-wrap break-words">
      {message}
    </div>
  )
}

function MessageStopped() {
  const { t } = useTranslation()
  return (
    <div className="mt-3 flex items-center gap-2 text-xs leading-5 text-text-tertiary" role="status">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary">
        {Icons.stop(9)}
      </span>
      <span>{t('session.pipeline.stopped')}</span>
    </div>
  )
}

interface MessageBubbleProps extends Message {
  enableActions?: boolean
  relatedUserMessage?: Message
  reportProviderId?: string
  reportThinking?: IssueReportThinkingSnapshot
  /** Play the enter animation. False for a bubble the transcript has already shown —
   *  a remount (streaming → final, a refresh that re-keys a row) must not replay it. */
  animateEnter?: boolean
}

export function MessageBubble({
  role = 'ai',
  content,
  type = 'text',
  messageId,
  turnId,
  model,
  executionMode,
  thinking,
  toolCalls,
  blocks,
  streaming,
  error,
  finalAnswer,
  turnStatus,
  stopped,
  sessionId,
  retry,
  completedAt,
  durationMs,
  startedAt,
  waitingForHumanRequest,
  enableActions = false,
  relatedUserMessage,
  reportProviderId,
  reportThinking,
  animateEnter = true,
}: MessageBubbleProps) {
  const { t } = useTranslation()
  const isUser = role === 'user'
  const liveSubagents = useAtomValue(subagentsAtom)
  const waitingForSubagent =
    !isUser && isParentWaitingForSubagents(blocks ?? [], liveSubagents, turnStatus)
  const activity = (() => {
    if (isUser || retry) return null
    if (waitingForHumanRequest) return { label: t('session.pipeline.activity.awaitingAnswer'), animated: false }
    if (!streaming && !waitingForSubagent) return null
    if (waitingForSubagent) return { label: t('session.pipeline.activity.awaitingSubagent') }
    const runningTool = [...(blocks ?? [])].reverse().find(
      (block): block is Extract<MessageBlock, { type: 'tool' }> => block.type === 'tool' && !block.result,
    )
    if (runningTool) {
      return {
        label: isBrowserAgentActionToolName(runningTool.name)
          ? t('session.pipeline.activity.usingBrowser')
          : t('session.pipeline.activity.callingTool'),
      }
    }
    const latestBlock = blocks?.at(-1)
    if (latestBlock?.type === 'workflow_step' && latestBlock.status === 'running') {
      return {
        label: latestBlock.phase === 'validate'
          ? t('session.pipeline.activity.validatingWorkflow')
          : t('session.pipeline.activity.runningWorkflow'),
      }
    }
    if (latestBlock?.type === 'text' || content) return { label: t('session.pipeline.activity.generating') }
    return { label: t('session.pipeline.activity.thinking') }
  })()
  return (
    <div
      className={cn(
        'group/message flex gap-2.5 items-start',
        animateEnter && 'animate-fade',
        // The user bubble is right-aligned and shrinks to its content; assistant takes the full row (w-full),
        // otherwise during streaming the width of the whole message would follow the widest block and tool
        // cards and the like would jitter horizontally.
        isUser ? 'max-w-[85%] self-end' : 'w-full',
      )}
    >
      {role === 'ai' && (
        // The square brand icon already ships with its own rounded corners and
        // gradient background — drop the outer bg/rounded container that we
        // used to need with the inline simplified glyph.
        <div className="mt-0.5">
          <BridgicLogo size={28} />
        </div>
      )}
      <div
        className={cn(
          // min-w-0: a flex item defaults to min-width:auto, so an over-wide whitespace-pre <pre> inside a tool
          // card would stretch this item → widening the whole message and even the conversation area. min-w-0
          // pins it to the width the flex layout assigned and lets the <pre> scroll horizontally with its own
          // overflow-auto.
          'flex min-w-0 flex-1 flex-col',
          isUser && 'items-end',
        )}
      >
        <div
          className={cn(
            'min-w-0',
            isUser
              ? 'max-w-full rounded-lg bg-msg-user-bg px-3.5 py-2.5'
              : 'w-full bg-transparent py-0.5',
          )}
        >
          {type === 'text' && (
            <TextMessageBody
              isUser={isUser}
              content={content}
              blocks={blocks}
              streaming={streaming}
              thinking={thinking}
              toolCalls={toolCalls}
              finalAnswer={finalAnswer}
              sessionId={sessionId}
              waitingForSubagent={waitingForSubagent}
              waitingForHumanRequest={waitingForHumanRequest}
            />
          )}
          {(streaming || waitingForSubagent || waitingForHumanRequest) && !isUser && (
            <div className="mt-2 flex min-h-7 min-w-0 flex-wrap items-center gap-2 text-xs text-text-tertiary">
              <ActiveTurnIndicator retry={retry} activity={activity} startedAt={startedAt} />
            </div>
          )}
          {stopped && !isUser && <MessageStopped />}
          {error && <MessageError message={error} />}
        </div>
        {isUser && enableActions && !streaming && (
          <div className="mt-1">
            <MessageActions
              role={role}
              content={content}
              blocks={blocks}
              finalAnswer={finalAnswer}
              error={error}
              stopped={stopped}
              messageId={messageId}
              turnId={turnId}
              sessionId={sessionId}
            />
          </div>
        )}
        {!streaming
          && !waitingForSubagent
          && !waitingForHumanRequest
          && !isUser
          && (enableActions || completedAt != null || durationMs != null) && (
          <div className="mt-2.5 flex min-h-7 w-full flex-wrap items-center gap-x-2.5 gap-y-1">
            <MessageCompletionBar completedAt={completedAt} durationMs={durationMs} />
            {enableActions && (
              <MessageActions
                role={role}
                content={content}
                thinking={thinking}
                toolCalls={toolCalls}
                blocks={blocks}
                finalAnswer={finalAnswer}
                error={error}
                stopped={stopped}
                messageId={messageId}
                turnId={turnId}
                sessionId={sessionId}
                relatedUserMessage={relatedUserMessage}
                model={model}
                executionMode={executionMode}
                reportProviderId={reportProviderId}
                reportThinking={reportThinking}
                turnStatus={turnStatus}
                completedAt={completedAt}
                durationMs={durationMs}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface MessageActionsProps extends Pick<
  Message,
  | 'role'
  | 'content'
  | 'thinking'
  | 'toolCalls'
  | 'blocks'
  | 'finalAnswer'
  | 'error'
  | 'stopped'
  | 'messageId'
  | 'turnId'
  | 'model'
  | 'executionMode'
  | 'turnStatus'
  | 'completedAt'
  | 'durationMs'
> {
  sessionId?: string
  relatedUserMessage?: Message
  reportProviderId?: string
  reportThinking?: IssueReportThinkingSnapshot
}

function MessageActions({
  role,
  content,
  thinking,
  toolCalls,
  blocks,
  finalAnswer,
  error,
  stopped,
  messageId,
  turnId,
  model,
  executionMode,
  turnStatus,
  completedAt,
  durationMs,
  sessionId,
  relatedUserMessage,
  reportProviderId,
  reportThinking,
}: MessageActionsProps) {
  const openIssueReport = useSetAtom(openIssueReportAtom)
  const text = messageActionText({ role, content, blocks, finalAnswer, error, stopped })
  const relatedUserText = relatedUserMessage
    ? messageActionText(relatedUserMessage)
    : undefined

  return (
    <MessageActionBar
      role={role}
      text={text}
      messageId={messageId}
      turnId={turnId}
      sessionId={sessionId}
      onReport={role === 'ai' ? () => {
        openIssueReport({
          source: 'message',
          sessionId,
          messageId,
          turnId,
          sourceRole: 'assistant',
          userText: relatedUserText,
          assistantText: text,
          agentTurn: {
            blocks: blocks ?? [],
            finalAnswer,
            fallbackText: content,
            thinking,
            toolCalls,
            error,
            stopped,
          },
          model: model ? {
            modelId: model,
            ...(reportProviderId ? { providerId: reportProviderId } : {}),
          } : undefined,
          executionMode,
          thinking: reportThinking,
          error,
          turnStatus: stopped ? 'cancelled' : turnStatus,
          completedAt,
          durationMs,
        })
      } : undefined}
    />
  )
}

function MessageCompletionBar({
  completedAt,
  durationMs,
}: {
  completedAt?: number | null
  durationMs?: number | null
}) {
  const { t, i18n } = useTranslation()
  if (completedAt == null && durationMs == null) return null
  const metrics: Array<{ text: string; title: string }> = []
  if (completedAt != null) {
    metrics.push({
      text: formatCompletionTime(completedAt, i18n.language),
      title: new Date(completedAt).toLocaleString(i18n.language),
    })
  }
  if (durationMs != null) {
    metrics.push({
      text: t('session.pipeline.duration', { duration: formatGenerationDuration(durationMs) }),
      title: t('session.pipeline.durationTitle', { milliseconds: durationMs.toLocaleString(i18n.language) }),
    })
  }
  return (
    <div
      className="flex w-fit select-none flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-5 text-text-tertiary tabular-nums"
      aria-label={t('session.pipeline.generationInfoAria')}
    >
      {metrics.map((metric, index) => (
        <span key={metric.text} className="contents">
          {index > 0 && <span className="opacity-50" aria-hidden="true">·</span>}
          <span>{metric.text}</span>
        </span>
      ))}
    </div>
  )
}

function formatCompletionTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function formatGenerationDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
  const totalSeconds = Math.round(durationMs / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function AgentActivityIndicator({
  label,
  startedAt,
  animated = true,
}: {
  label: string
  startedAt?: number
  animated?: boolean
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-2"
      role="status"
      aria-label={label}
    >
      {animated ? (
        <span className="agent-activity-wave shrink-0" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : (
        <span className="flex shrink-0 text-brand-blue" aria-hidden="true">{Icons.chat(13)}</span>
      )}
      <span className="shrink-0 font-medium text-brand-blue">{label}</span>
      <ActiveElapsedTime startedAt={startedAt} />
    </div>
  )
}

function ActiveElapsedTime({ startedAt }: { startedAt?: number }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  if (startedAt == null || !Number.isFinite(startedAt)) return null
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  return (
    <span
      className="shrink-0 font-mono tabular-nums text-text-tertiary"
      aria-label={t('session.pipeline.activeElapsedAria', { seconds: elapsedSeconds })}
    >
      {formatActiveElapsedTime(elapsedSeconds)}
    </span>
  )
}

function formatActiveElapsedTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const minuteSecond = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return hours > 0 ? `${hours}:${minuteSecond}` : minuteSecond
}

/**
 * Status line while streaming is in progress: the retry hint takes precedence over the activity hint, and with neither, nothing is rendered.
 *
 * Extracted into a component rather than written as a nested ternary in JSX (§1.24: JSX conditional
 * rendering must be extracted into a child component, lifting a ReactNode variable is forbidden) —
 * early returns give every branch a name and let it be read on its own.
 */
function ActiveTurnIndicator({
  retry,
  activity,
  startedAt,
}: {
  retry: StreamingState['retry']
  /** The activity hint computed in place (see `const activity` above), not a field of StreamingState. */
  activity: { label: string; animated?: boolean } | null
  startedAt?: number
}) {
  if (retry) return <ModelRetryIndicator retry={retry} startedAt={startedAt} />
  if (!activity) return null
  return <AgentActivityIndicator {...activity} startedAt={startedAt} />
}

function ModelRetryIndicator({
  retry,
  startedAt,
}: {
  retry: NonNullable<StreamingState['retry']>
  startedAt?: number
}) {
  const { t } = useTranslation()
  return (
    <div
      className="inline-flex items-center gap-2 rounded-md bg-accent-blue-subtle px-2.5 py-1.5 text-xs text-brand-blue"
      role="status"
      aria-label={t('session.pipeline.reconnectingAria', { attempt: retry.attempt, max: retry.maxRetries })}
    >
      <span className="flex shrink-0 animate-spin">{Icons.refresh(12)}</span>
      <span>
        {t('session.pipeline.reconnecting', { attempt: retry.attempt, max: retry.maxRetries })}
      </span>
      <ActiveElapsedTime startedAt={startedAt} />
    </div>
  )
}

/*
 * NOTE: The legacy `InputBar` component was removed in Task 5. The
 * composer (`ChatInputZone` + `FreeFormInput`) now lives in
 * `components/composer/` and is rendered as a sibling of `<Pipeline>`
 * from `App.tsx`. Do not re-introduce InputBar here — Pipeline is
 * stage-indicator + messages only.
 */
