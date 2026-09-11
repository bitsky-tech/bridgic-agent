import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Crosshair, ExternalLink, Repeat2, Wrench, X } from 'lucide-react'
import type { SessionWorkbenchExtensionProps } from '@/components/app/DesktopAppExtensions'
import { WorkbenchToolHeader, WorkbenchToolScrollArea, WorkbenchToolSurface, WorkbenchSearchField } from '@/components/app/WorkbenchToolPrimitives'
import { useDebugSession, useDebugText, type DebugPanelKind } from './DebugSessionProvider'
import { JsonRecord, RoundMetrics, RoundResponse, ToolRow, TraceStatusLabel, duration, roundLabel, turnLabel } from './TraceParts'
import type { TraceRound, TraceToolCall } from './types'
import { RoundTurnList, TurnContext } from './RoundTurnList'
import { groupRoundsByTurn, userInputText } from './trace-presentation'
import { StageFilter, roundStageKey } from './StageFilter'

function ToolDetail({ call }: { call: TraceToolCall }) {
  const { records, turns, inspect, locate } = useDebugSession()
  const text = useDebugText()
  const round = records.rounds.find((item) => item.id === call.roundId)
  return <div className="debug-detail">
    <h3><Wrench size={17} /><span>{call.name ?? text('未知工具', 'Unknown tool')}</span></h3>
    <div className="debug-detail-meta"><TraceStatusLabel status={call.status} /><span>{text('执行耗时', 'Duration')} {duration(call.durationMs)}</span></div>
    <p className="debug-muted">Turn {turnLabel(call.turnOrdinal)} · {round ? roundLabel(round) : '—'}</p>
    <TurnContext turn={turns.find((turn) => turn.id === call.turnId)} ordinal={call.turnOrdinal} />
    <div className="debug-detail-actions">
      {round ? <><button type="button" onClick={() => locate(round)}><Crosshair size={13} />{text('定位到对话', 'Locate in chat')}</button>
        <button type="button" onClick={() => inspect('rounds', round.id)}><Repeat2 size={13} />{text('查看所属循环', 'Inspect round')}</button></> : null}
    </div>
    <JsonRecord title={text('调用参数', 'Arguments')} value={call.arguments} />
    <JsonRecord title={text('执行结果', 'Result')} value={call.hasResult ? call.result : undefined} />
    {call.error !== undefined && call.error !== null ? <JsonRecord title={text('错误', 'Error')} value={call.error} /> : null}
    <JsonRecord title={text('原始调用记录', 'Raw call')} value={call.rawCall} open={false} />
    <JsonRecord title={text('原始结果记录', 'Raw result')} value={call.rawResult} open={false} />
  </div>
}

function RoundDetail({ round }: { round: TraceRound }) {
  const text = useDebugText()
  const { turns, inspect, locate } = useDebugSession()
  const [tab, setTab] = useState<'output' | 'request' | 'raw'>('output')
  const hasRequest = Object.keys(round.recordedRequest).length > 0
  const tabs = { output: text('输出与调用', 'Output & calls'), request: text('模型请求', 'Model request'), raw: text('原始记录', 'Raw record') }
  let tabContent
  if (tab === 'output') tabContent = <div role="tabpanel"><RoundResponse round={round} />
    {round.calls.map((call) => <ToolRow key={call.id} call={call} onClick={() => inspect('tools', call.id)} />)}
    {round.actDurationMs != null ? <p className="debug-muted">{text('整组工具执行耗时', 'Action group duration')} {duration(round.actDurationMs)}</p> : null}
  </div>
  else if (tab === 'request') tabContent = <div role="tabpanel">
    {hasRequest ? <><p className="debug-muted">{text('以下为保存的请求字段，完整性取决于当时的记录。', 'Stored request fields; completeness depends on the original record.')}</p><JsonRecord title={text('已保存的请求字段', 'Recorded request fields')} value={round.recordedRequest} /></>
      : <p className="debug-empty">{text('这份执行记录没有保存模型请求，暂时无法查看完整 Prompt。', 'This execution record did not retain the model request. The full prompt is unavailable.')}</p>}
  </div>
  else tabContent = <div role="tabpanel">
    <JsonRecord title={text('循环记录', 'Round record')} value={round.raw} />
    <JsonRecord title={text('用量字段来源', 'Usage sources')} value={round.usageSources} open={false} />
    <JsonRecord title={text('用量字段检查', 'Usage validation')} value={round.usageIssues} open={false} />
  </div>
  return <div className="debug-detail">
    <h3><code>{roundLabel(round)}</code><span>{text('模型响应', 'Model response')}</span></h3>
    <p className="debug-muted">Turn {turnLabel(round.turnOrdinal)} · {round.model ?? text('模型未记录', 'Model not recorded')}{round.stage && round.stage !== 'main' ? ` · ${round.stage}` : ''}</p>
    <TurnContext turn={turns.find((turn) => turn.id === round.turnId)} ordinal={round.turnOrdinal} />
    <RoundMetrics round={round} />
    <div className="debug-detail-actions"><button type="button" onClick={() => locate(round)}><Crosshair size={13} />{text('定位到对话', 'Locate in chat')}</button></div>
    <div role="tablist" className="debug-detail-tabs">
      {(['output', 'request', 'raw'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{tabs[value]}</button>)}
    </div>
    {tabContent}
  </div>
}

function DebugPanel({ kind, active, onClose }: SessionWorkbenchExtensionProps & { kind: DebugPanelKind }) {
  const debug = useDebugSession()
  const text = useDebugText()
  const [query, setQuery] = useState('')
  const [toolName, setToolName] = useState('')
  const [status, setStatus] = useState('all')
  const [stage, setStage] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [appliedSelection, setAppliedSelection] = useState<number | null>(null)
  const tools = kind === 'tools'
  const names = useMemo(() => [...new Set(debug.records.calls.map((call) => call.name).filter((name): name is string => Boolean(name)))].sort(), [debug.records.calls])
  const needle = query.toLocaleLowerCase().trim()
  const calls = debug.records.calls.filter((call) => (!toolName || call.name === toolName)
    && (status === 'all' || call.status === status)
    && `${call.name ?? ''} ${call.sourceCallId ?? ''} ${turnLabel(call.turnOrdinal)}`.toLocaleLowerCase().includes(needle)).slice().reverse()
  const inputByTurn = new Map(debug.turns.map((turn) => [turn.id, userInputText(turn.userInput) ?? '']))
  const rounds = debug.records.rounds.filter((round) => (!stage || roundStageKey(round) === stage)
    && `${roundLabel(round)} ${round.stage ?? ''} ${round.mode ?? ''} ${round.model ?? ''} ${turnLabel(round.turnOrdinal)} ${inputByTurn.get(round.turnId) ?? ''} ${round.body ?? ''} ${round.calls.map((call) => call.name ?? '').join(' ')}`.toLocaleLowerCase().includes(needle))
  const selectedCall = tools ? debug.records.calls.find((call) => call.id === detailId) : undefined
  const selectedRound = !tools ? debug.records.rounds.find((round) => round.id === detailId) : undefined

  const selection = debug.selection
  if (active && selection && selection.kind === kind && appliedSelection !== selection.nonce) {
    setAppliedSelection(selection.nonce)
    setQuery(''); setToolName(''); setStatus('all'); setStage(''); setDetailId(null); setFocusedId(selection.id)
  }
  if (!debug.loading) {
    if (detailId && !selectedCall && !selectedRound) setDetailId(null)
    if (focusedId && !(tools ? debug.records.calls : debug.records.rounds).some((record) => record.id === focusedId)) setFocusedId(null)
    if (toolName && !names.includes(toolName)) setToolName('')
    if (stage && !debug.records.rounds.some((round) => roundStageKey(round) === stage)) setStage('')
  }
  useEffect(() => {
    if (!active || !focusedId || detailId) return
    const frame = requestAnimationFrame(() => {
      const target = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-debug-record]') ?? [])
        .find((element) => element.dataset.debugRecord === focusedId)
      const group = target?.closest<HTMLDetailsElement>('details[data-debug-turn]')
      if (group) group.open = true
      target?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedId, active, detailId, debug.selection?.nonce])
  let detail
  if (selectedCall) detail = <ToolDetail key={selectedCall.id} call={selectedCall} />
  else if (selectedRound) detail = <RoundDetail key={selectedRound.id} round={selectedRound} />
  let emptyText = text('当前会话还没有已保存的执行记录', 'No saved execution records in this session')
  if (debug.loading) emptyText = text('正在读取执行记录…', 'Loading execution records…')
  else if (query || toolName || stage || status !== 'all') emptyText = text('没有匹配的记录', 'No matching records')

  return <WorkbenchToolSurface testId={`desktop-debug-${kind}`}>
    <WorkbenchToolHeader title={tools ? text('工具调用', 'Tool calls') : text('Agent 循环', 'Agent rounds')}
      icon={tools ? <Wrench size={16} /> : <Repeat2 size={16} />}
      actions={<button type="button" aria-label={text('关闭面板', 'Close panel')} onClick={onClose}><X size={16} /></button>} />
    <WorkbenchToolScrollArea className="debug-panel">
      {debug.error ? <p role="alert" className="debug-notice">{text('读取失败', 'Read failed')} · {debug.error}</p> : null}
      {selectedCall || selectedRound ? <>
        <button className="debug-back" type="button" onClick={() => setDetailId(null)}><ArrowLeft size={13} />{text('返回列表', 'Back to list')}</button>
        {detail}
      </> : <>
        <WorkbenchSearchField query={query} onQueryChange={setQuery} clearLabel={text('清空搜索', 'Clear search')} searchPlaceholder={tools ? text('搜索工具名称或调用 ID…', 'Search tool name or call ID…') : text('搜索用户消息、输出或工具…', 'Search user input, output or tools…')} />
        {!tools ? <StageFilter rounds={debug.records.rounds} value={stage} onChange={(value) => { setStage(value); setFocusedId(null) }} /> : null}
        <div className="debug-list-filters">
          <span>{text('当前会话', 'Current session')} · {tools ? debug.records.calls.length : `${groupRoundsByTurn(debug.turns, rounds).length} Turn · ${rounds.length} ${text('轮', 'rounds')}`}</span>
          {tools ? <><select aria-label={text('按工具名称筛选', 'Filter by tool')} value={toolName} onChange={(event) => setToolName(event.target.value)}><option value="">{text('全部工具', 'All tools')}</option>{names.map((name) => <option key={name}>{name}</option>)}</select>
            <select aria-label={text('按状态筛选', 'Filter by status')} value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">{text('全部状态', 'All statuses')}</option><option value="error">{text('失败', 'Failed')}</option><option value="success">{text('成功', 'Success')}</option><option value="unknown">{text('结果未记录', 'No result')}</option></select></> : null}
        </div>
        <div ref={listRef} className="debug-record-list">
          {tools ? calls.map((call) => <button key={call.id} type="button" data-debug-record={call.id} className={`debug-record-card ${focusedId === call.id ? 'is-focused' : ''}`} onClick={() => setDetailId(call.id)}>
            <strong><Wrench size={15} /><code>{call.name ?? text('未知工具', 'Unknown tool')}</code><ExternalLink size={12} /></strong>
            <div className="debug-detail-meta"><TraceStatusLabel status={call.status} /><span>{duration(call.durationMs)}</span></div>
            <div className="debug-record-footer"><span>Turn {turnLabel(call.turnOrdinal)} · {roundLabel(debug.records.rounds.find((round) => round.id === call.roundId))}</span><code>{call.sourceCallId ?? '—'}</code></div>
          </button>) : <RoundTurnList turns={debug.turns} rounds={rounds} focusedId={focusedId} onSelect={setDetailId} />}
        </div>
        {(tools ? calls : rounds).length === 0 ? <p className="debug-empty">{emptyText}</p> : null}
        {debug.hasMore ? <button type="button" className="debug-load-earlier" disabled={debug.loading} onClick={debug.loadMore}>{text('加载更早的记录', 'Load earlier records')}</button> : null}
        <p className="debug-list-note">{text('已保存的实际记录 · 缺失字段显示为 —', 'Saved execution records · Missing fields appear as —')}</p>
        {debug.records.issues.length ? <p className="debug-notice">{text('部分历史记录格式不完整', 'Some historical records are incomplete')} · {debug.records.issues.length}</p> : null}
      </>}
    </WorkbenchToolScrollArea>
  </WorkbenchToolSurface>
}

export function DebugToolsPanel(props: SessionWorkbenchExtensionProps) { return <DebugPanel key={props.sessionId} {...props} kind="tools" /> }
export function DebugRoundsPanel(props: SessionWorkbenchExtensionProps) { return <DebugPanel key={props.sessionId} {...props} kind="rounds" /> }
