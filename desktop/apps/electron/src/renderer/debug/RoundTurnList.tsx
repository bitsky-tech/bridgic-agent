import { ChevronDown, ExternalLink, MessageSquare, Repeat2, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DesktopDebugTurn } from '@shared/debug-types'
import { useDebugText } from './DebugSessionProvider'
import { RoundMetrics, roundLabel, turnLabel } from './TraceParts'
import { groupRoundsByTurn, roundPreview, userInputText } from './trace-presentation'
import type { TraceRound } from './types'

export function TurnContext({ turn, ordinal, children }: { turn?: DesktopDebugTurn; ordinal: number; children?: ReactNode }) {
  const text = useDebugText()
  const input = userInputText(turn?.userInput)
  return <div className="debug-turn-context debug-inspector-card debug-inspector-source">
    <div className="debug-inspector-heading"><MessageSquare size={15} aria-hidden="true" /><h4>{text('用户输入', 'User input')}</h4><span className="debug-inspector-caption">Turn {turnLabel(ordinal)}</span></div>
    <div className="debug-inspector-body"><p className="debug-inspector-message">{input ?? text('这次用户输入未记录', 'User input was not recorded')}</p></div>
    {children}
  </div>
}

export function RoundTurnList({ turns, rounds, focusedId, onSelect }: {
  turns: DesktopDebugTurn[]; rounds: TraceRound[]; focusedId: string | null; onSelect: (id: string) => void
}) {
  const text = useDebugText()
  return <>{groupRoundsByTurn(turns, rounds).map((group) => {
    const input = userInputText(group.turn?.userInput)
    return <details open className="debug-turn-group" data-debug-turn={group.turnId} key={group.turnId}>
      <summary>
        <span className="debug-turn-heading"><ChevronDown size={14} /><strong>Turn {turnLabel(group.turnOrdinal)}</strong>
          <span>{group.rounds.length} {text('轮', 'rounds')}</span></span>
        <span className="debug-turn-input" title={input ?? undefined}><MessageSquare size={13} />
          <span>{input ?? text('这次用户输入未记录', 'User input was not recorded')}</span></span>
      </summary>
      <div className="debug-turn-rounds">
        {group.rounds.map((round) => {
          const preview = roundPreview(round)
          const stage = round.stage && round.stage !== 'main' ? round.stage : null
          let fallback = text('此轮没有可展示的输出记录', 'No output recorded for this round')
          if (round.calls.length) fallback = text('返回工具调用', 'Returned tool calls')
          else if (preview.hasThinking) fallback = text('已记录 Thinking，展开查看', 'Thinking recorded; open to inspect')
          return <button key={round.id} type="button" data-debug-record={round.id}
            className={`debug-record-card debug-round-preview ${focusedId === round.id ? 'is-focused' : ''}`} onClick={() => onSelect(round.id)}>
            <strong><Repeat2 size={14} /><code>{roundLabel(round)}</code><span>{text('模型响应', 'Model response')}</span><ExternalLink size={12} /></strong>
            {stage ? <span className="debug-round-stage">{stage}</span> : null}
            <p className={`debug-round-excerpt ${preview.body ? '' : 'debug-muted'}`}>{preview.body ?? fallback}</p>
            {round.calls.length ? <div className="debug-round-tools"><Wrench size={12} />
              <span>{preview.toolNames.join(' · ') || text('工具名称未记录', 'Tool names not recorded')}</span>
              <span className="debug-round-call-count">{round.calls.length} {text('次调用', 'calls')}</span>
            </div> : null}
            <RoundMetrics round={round} />
          </button>
        })}
      </div>
    </details>
  })}</>
}
