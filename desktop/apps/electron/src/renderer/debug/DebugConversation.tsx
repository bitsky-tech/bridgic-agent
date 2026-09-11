import { useMemo, useState, type ReactNode } from 'react'
import { useAtomValue } from 'jotai'
import { ChevronDown, ExternalLink, FlaskConical, Layers3 } from 'lucide-react'
import { Pipeline, type Message } from '@/components/amphi/Pipeline'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { MessageContent } from '@/components/amphi/MessageContent'
import type { ConversationHistoryProps } from '@/components/app/DesktopAppExtensions'
import { currentMessagesAtom } from '@/atoms/agent'
import { debugRoundElementId, useDebugSession, useDebugText } from './DebugSessionProvider'
import { RoundMetrics, RoundResponse, ToolRow, roundLabel } from './TraceParts'
import type { TraceRound } from './types'

function RoundCard({ round }: { round: TraceRound }) {
  const { inspect } = useDebugSession()
  const text = useDebugText()
  return <details open className="debug-round-card" id={debugRoundElementId(round.id)} tabIndex={-1}>
    <summary>
      <ChevronDown size={13} /><code>{roundLabel(round)}</code><span>{text('模型响应', 'Model response')}</span>
      <button type="button" onClick={(event) => { event.preventDefault(); inspect('rounds', round.id) }}>
        {text('详情', 'Inspect')} <ExternalLink size={12} />
      </button>
    </summary>
    <div className="debug-round-body">
      <RoundResponse round={round} />
      {round.calls.map((call) => <ToolRow key={call.id} call={call} onClick={() => inspect('tools', call.id)} />)}
    </div>
    <RoundMetrics round={round} />
  </details>
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
  if (hasUnrecordedContent || !rounds.some((round) => round.body?.trim())) return <>{trace}<details className="debug-product-trace"><summary>{text('产品会话记录', 'Product conversation record')}</summary>{original}</details></>
  return <>{trace}{finalAnswer?.trim() && !rounds.some((round) => round.body === finalAnswer)
    ? <div className="debug-final-answer"><MarkdownMessage content={finalAnswer} /></div> : null}
    {productBlocks.length ? <MessageContent blocks={productBlocks} finalAnswer={null} sessionId={sessionId} processPresentation="inline"
      waitingForSubagent={message.turnStatus === 'awaiting_subagents'} /> : null}</>
}

export function DebugConversation({ sessionId }: ConversationHistoryProps) {
  const debug = useDebugSession()
  const messages = useAtomValue(currentMessagesAtom)
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
  return <div className="debug-conversation" data-testid="desktop-debug-conversation">
    <header className="debug-conversation-header">
      <span><FlaskConical size={14} />{text('调试会话', 'Debug conversation')}</span>
      <div className="debug-view-switch">
        <button type="button" aria-pressed={executionView} onClick={() => setExecutionView(true)}>{text('执行视图', 'Execution')}</button>
        <button type="button" aria-pressed={!executionView} onClick={() => setExecutionView(false)}>{text('对话视图', 'Conversation')}</button>
      </div>
    </header>
    {debug.error || debug.notice ? <div role="status" className="debug-notice">{debug.notice ?? text('执行记录读取失败，聊天仍可正常使用。', 'Trace unavailable. Chat remains available.')} {debug.error}</div> : null}
    {debug.hasMore ? <button className="debug-load-earlier" type="button" disabled={debug.loading} onClick={debug.loadMore}>{text('加载更早的执行记录', 'Load earlier execution records')}</button> : null}
    <div className="debug-conversation-content">
      <Pipeline
        revealRequest={debug.reveal}
        onRevealFailed={debug.revealFailed}
        renderAssistantBody={(message, original) => {
          const rounds = message.turnId ? byTurn.get(message.turnId) : undefined
          if (!executionView || debug.sessionId !== sessionId || !rounds?.length
            || (message.turnId && traceOwners.get(message.turnId) !== message.messageId)) return original
          return <TurnBody message={message} rounds={rounds} original={original} sessionId={sessionId} />
        }}
      />
    </div>
  </div>
}
