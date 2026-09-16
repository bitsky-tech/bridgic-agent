import { useMemo, useState, type ReactNode } from 'react'
import { useAtomValue } from 'jotai'
import { ChevronDown, ExternalLink, FlaskConical, Layers3, Wrench } from 'lucide-react'
import { Pipeline, type Message } from '@/components/amphi/Pipeline'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { MessageContent } from '@/components/amphi/MessageContent'
import { SubagentGroup } from '@/components/amphi/SubagentGroup'
import type { ConversationHistoryProps } from '@/components/app/DesktopAppExtensions'
import { WorkbenchToolHeader } from '@/components/app/WorkbenchToolPrimitives'
import { currentMessagesAtom } from '@/atoms/agent'
import { debugRoundElementId, useDebugSession, useDebugText } from './DebugSessionProvider'
import { RoundMetrics, RoundResponse, ToolRow, TraceStatusLabel, duration, roundLabel } from './TraceParts'
import type { TraceRound } from './types'
import { liveDebugTurnsFamily } from './live-trace-state'
import { savedRoundsCoverLive, type LivePhase, type LiveTurn } from './live-trace'

function RoundCard({ round, phase }: { round: TraceRound; phase?: LivePhase }) {
  const { inspect } = useDebugSession()
  const text = useDebugText()
  const pendingPhase = phase === 'running' || phase === 'waiting' ? phase : 'noResult'
  return <details open className="debug-round-card" id={debugRoundElementId(round.id)} tabIndex={-1}>
    <summary>
      <ChevronDown size={13} /><code>{roundLabel(round)}</code><span>{text('modelResponse')}</span>
      {phase ? <span className="debug-live-phase" role="status">{text(`live.${phase}`)}</span> : null}
      <button type="button" disabled={Boolean(phase)} title={phase ? text('live.detailsPending') : undefined} onClick={(event) => { event.preventDefault(); inspect('rounds', round.id) }}>
        {text('inspect')} <ExternalLink size={12} />
      </button>
    </summary>
    <div className="debug-round-body">
      {phase && !round.body?.trim() && !round.thinking?.trim() && !round.calls.length
        ? <p className="debug-muted">{text(`live.${phase}`)}</p> : <RoundResponse round={round} />}
      {round.calls.map((call) => phase ? <details key={call.id} className="debug-live-tool">
        <summary className="debug-tool-row"><Wrench size={13} /><code>{call.name ?? text('unknownTool')}</code>
          <span className="debug-tool-summary">{JSON.stringify(call.arguments)}</span>
          {call.hasResult ? <TraceStatusLabel status={call.status} /> : <span className="debug-live-phase">{text(`live.${pendingPhase}`)}</span>}
          <ChevronDown size={12} />
        </summary>
        <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
        {call.hasResult ? <><p className="debug-muted">{text('duration')} {duration(call.durationMs)}</p><pre>{typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2)}</pre></> : null}
      </details> : <ToolRow key={call.id} call={call} onClick={() => inspect('tools', call.id)} />)}
    </div>
    <RoundMetrics round={round} />
  </details>
}

function LiveTurnBody({ turn, message, original, sessionId }: { turn: LiveTurn; message: Message; original: ReactNode; sessionId: string }) {
  const text = useDebugText()
  const groups: { key: string; mode: string | null; stage: string | null; rounds: LiveTurn['rounds'] }[] = []
  for (const round of turn.rounds) {
    const { mode, stage } = round.record
    const previous = groups.at(-1)
    if (previous && previous.mode === mode && previous.stage === stage) previous.rounds.push(round)
    else groups.push({ key: round.record.id, mode, stage, rounds: [round] })
  }
  const productBlocks = message.blocks?.filter(block => !['text', 'thinking', 'tool', 'build_stage'].includes(block.type)) ?? []
  const children = [...new Map((message.blocks?.flatMap(block => block.type === 'tool' ? block.subagents ?? [] : []) ?? [])
    .map(child => [child.invocationId, child])).values()]
  const trace = <>
    <div className="debug-turn-tree" data-live-trace={turn.messageId}>
      {groups.map(group => <section className="debug-stage" key={group.key}>
        {group.stage || group.mode ? <div className="debug-stage-heading"><Layers3 size={14} /><span>{group.stage ?? group.mode}</span>{group.stage && group.mode ? <code>{group.mode}</code> : null}</div> : null}
        <div className="debug-stage-rounds">{group.rounds.map(round => <RoundCard key={round.record.id} round={round.record} phase={round.phase} />)}</div>
      </section>)}
    </div>
    {message.finalAnswer?.trim() && !turn.rounds.some(round => round.record.body === message.finalAnswer)
      ? <div className="debug-final-answer"><MarkdownMessage content={message.finalAnswer} /></div> : null}
  </>
  // A resumed transcript can arrive before its debug history. Preserve content
  // not observed by this projection until a complete saved record takes over.
  if (hasUnrecordedTranscript(message, turn.rounds.map(round => round.record))) return <>{trace}
    <details open className="debug-product-trace"><summary>{text('productConversationRecord')}</summary>{original}</details>
  </>
  return <>{trace}
    {children.length ? <SubagentGroup subagents={children} /> : null}
    {productBlocks.length ? <MessageContent blocks={productBlocks} finalAnswer={null} sessionId={sessionId} processPresentation="inline"
      streaming={message.streaming} waitingForSubagent={message.turnStatus === 'awaiting_subagents'} /> : null}
  </>
}

function hasUnrecordedTranscript(message: Message, rounds: TraceRound[]): boolean {
  const coversText = (value: string, recorded: string[]) => !value.trim()
    || recorded.join('').includes(value.trim()) || recorded.join('\n\n').includes(value.trim())
  const texts = [...rounds.map(round => round.body ?? ''), message.finalAnswer ?? '']
  const thinking = rounds.map(round => round.thinking ?? '')
  const calls = rounds.flatMap(round => round.calls)
  if (!message.blocks?.length) return !coversText(message.content, texts) || !coversText(message.thinking ?? '', thinking)
    || (message.toolCalls ?? []).some(call => !calls.some(record => record.sourceCallId === call.toolUseId && (!call.result || record.hasResult)))
  return message.blocks.some(block => {
    if (block.type === 'text') return !coversText(block.text, texts)
    if (block.type === 'thinking') return !coversText(block.text, thinking)
    if (block.type === 'tool') return !calls.some(call => call.sourceCallId === block.toolUseId && (!block.result || call.hasResult))
    return false
  })
}

function TurnBody({ message, rounds, original, sessionId }: { message: Message; rounds: TraceRound[]; original: ReactNode; sessionId: string }) {
  const text = useDebugText()
  const groups: { key: string; mode: string | null; stage: string | null; rounds: TraceRound[] }[] = []
  for (const round of rounds) {
    const previous = groups.at(-1)
    if (previous && previous.mode === round.mode && previous.stage === round.stage) previous.rounds.push(round)
    else groups.push({ key: round.id, mode: round.mode, stage: round.stage, rounds: [round] })
  }
  const productBlocks = message.blocks?.filter((block) => !['text', 'thinking', 'tool', 'build_stage'].includes(block.type)) ?? []
  const finalAnswer = message.finalAnswer
  const transcriptTexts = message.blocks?.length ? message.blocks.flatMap((block) => block.type === 'text' ? [block.text] : []) : [message.content]
  const recordedTexts = [...rounds.flatMap((round) => typeof round.body === 'string' ? [round.body] : []), finalAnswer ?? ''].join('\n\n')
  const transcriptThinking = message.blocks?.flatMap((block) => block.type === 'thinking' ? [block.text] : []) ?? [message.thinking ?? '']
  const recordedThinking = rounds.map((round) => round.thinking ?? '').join('\n\n')
  const hasUnrecordedContent = transcriptTexts.some((value) => value.trim() && !recordedTexts.includes(value.trim()))
    || transcriptThinking.some((value) => value.trim() && !recordedThinking.includes(value.trim()))
  const trace = <div className="debug-turn-tree">
    {groups.map((group) => <section className="debug-stage" key={group.key}>
      {group.stage || group.mode ? <div className="debug-stage-heading"><Layers3 size={14} /><span>{group.stage ?? group.mode}</span>{group.stage && group.mode ? <code>{group.mode}</code> : null}</div> : null}
      <div className="debug-stage-rounds">{group.rounds.map((round) => <RoundCard key={round.id} round={round} />)}</div>
    </section>)}
  </div>
  // Keep incomplete transcript mappings inspectable without placing the entire
  // product execution timeline ahead of the developer trace.
  if (hasUnrecordedContent || !rounds.some((round) => round.body?.trim())) return <>{trace}<details className="debug-product-trace"><summary>{text('productConversationRecord')}</summary>{original}</details></>
  return <>{trace}{finalAnswer?.trim() && !rounds.some((round) => round.body === finalAnswer)
    ? <div className="debug-final-answer"><MarkdownMessage content={finalAnswer} /></div> : null}
    {productBlocks.length ? <MessageContent blocks={productBlocks} finalAnswer={null} sessionId={sessionId} processPresentation="inline"
      waitingForSubagent={message.turnStatus === 'awaiting_subagents'} /> : null}</>
}

export function DebugConversation({ sessionId }: ConversationHistoryProps) {
  const debug = useDebugSession()
  const messages = useAtomValue(currentMessagesAtom)
  const liveTurns = useAtomValue(liveDebugTurnsFamily(sessionId))
  const text = useDebugText()
  const [executionView, setExecutionView] = useState(true)
  const byTurn = useMemo(() => {
    const map = new Map<string, TraceRound[]>()
    for (const round of debug.records.rounds) map.set(round.turnId, [...(map.get(round.turnId) ?? []), round])
    return map
  }, [debug.records.rounds])
  const traceOwners = useMemo(() => {
    const owners = new Map<string, string>()
    for (const message of messages) if (message.role === 'assistant' && message.turnId) owners.set(message.turnId, message.id)
    return owners
  }, [messages])
  const userByReply = new Map<string, string>()
  let userId: string | undefined
  for (const message of messages) {
    if (message.role === 'user') userId = message.id
    else if (userId) userByReply.set(message.id, userId)
  }
  return <div className="debug-conversation" data-testid="desktop-debug-conversation">
    <WorkbenchToolHeader title={text('debugConversation')} icon={<FlaskConical size={16} />}
      iconClassName="text-text-accent-purple" actions={<div className="debug-view-switch">
        <button type="button" aria-pressed={executionView} onClick={() => setExecutionView(true)}>{text('execution')}</button>
        <button type="button" aria-pressed={!executionView} onClick={() => setExecutionView(false)}>{text('conversation')}</button>
      </div>} />
    {debug.error || debug.notice ? <div role="status" className="debug-notice">{debug.notice ?? text('traceUnavailableNotice')} {debug.error}</div> : null}
    {debug.hasMore ? <button className="debug-load-earlier" type="button" disabled={debug.loading} onClick={debug.loadMore}>{text('loadEarlierExecutionRecords')}</button> : null}
    <div className="debug-conversation-content">
      <Pipeline
        revealRequest={debug.reveal}
        onRevealFailed={debug.revealFailed}
        renderAssistantBody={(message, original) => {
          if (!executionView || debug.sessionId !== sessionId) return original
          if (message.turnId && traceOwners.get(message.turnId) !== message.messageId) return original
          const rounds = message.turnId ? byTurn.get(message.turnId) : undefined
          const live = liveTurns.find(turn => turn.messageId === message.messageId)
            ?? (!message.streaming ? liveTurns.findLast(turn => (message.turnId && turn.turnId === message.turnId)
              || (turn.userMessageId && turn.userMessageId === userByReply.get(message.messageId ?? ''))) : undefined)
          if (live && (message.streaming || !rounds?.length || !savedRoundsCoverLive(rounds, live))) {
            return <LiveTurnBody turn={live} message={message} original={original} sessionId={sessionId} />
          }
          if (!rounds?.length) return original
          return <TurnBody message={message} rounds={rounds} original={original} sessionId={sessionId} />
        }}
      />
    </div>
  </div>
}
