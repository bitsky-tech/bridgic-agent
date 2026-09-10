import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Braces, BrainCircuit, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, FileText, FlaskConical, LocateFixed, Play, RotateCcw, Search, Square, Wrench } from 'lucide-react'
import { useI18n } from '../i18n'
import type { DebugOpenRequest, DebugRecords, DebugRecordStatus, DebugRound, DebugToolCall } from './debug-record-types'
import { createDebugSimulationReceipt, debugRoundTabs, emptyDebugFilters, filterDebugCalls, filterDebugRounds, isValidRoundRequest, nextDebugRoundTab, parseDebugArguments, roundRequest, type DebugFilters, type DebugRoundTab, type DebugSimulationReceipt } from './debug-panel-state'
import './debug-workbench-panel.css'

interface Props {
  sessionId?: string
  surface: 'tools' | 'rounds'
  records: DebugRecords
  request: DebugOpenRequest | null
  onLocateRound: (round: DebugRound) => void
  onArtifact?: (artifact: 'brief' | 'sources' | 'outline') => void
  renderToolExtra?: (call: DebugToolCall) => ReactNode
}
type Detail = { kind: 'list' } | { kind: 'tool'; id: string; fromRound?: string } | { kind: 'round'; id: string }
type Text = (zh: string, en: string) => string
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? ''

function statusText(status: DebugRecordStatus, t: Text, round = false) {
  if (round && status === 'success') return t('本轮完成', 'Round complete')
  if (round && status === 'error') return t('含失败调用', 'Tool failures')
  return { success: t('成功', 'Succeeded'), error: t('失败', 'Failed'), running: t('执行中', 'Running'), cancelled: t('已停止', 'Stopped'), waiting: t('等待用户', 'Awaiting user'), example: t('预设示例', 'Example') }[status]
}

function Status({ status, t, round = false }: { status: DebugRecordStatus; t: Text; round?: boolean }) {
  return <span className={`debug-record-status is-${status}`}>
    {status === 'success' ? <Check size={12} /> : status === 'error' ? <CircleAlert size={12} /> : status === 'cancelled' ? <Square size={11} /> : status === 'example' ? <FlaskConical size={12} /> : <Clock3 size={12} />}
    {statusText(status, t, round)}
  </span>
}

function JsonView({ value, empty }: { value: unknown; empty: string }) {
  return value === null || value === undefined ? <p className="debug-empty-value">{empty}</p> : <pre className="debug-json">{typeof value === 'string' ? value : pretty(value)}</pre>
}

function DetailSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="debug-detail-section"><header><h4>{title}</h4>{aside}</header>{children}</section>
}

export function DebugWorkbenchPanel({ sessionId, surface, records, request, onLocateRound, onArtifact, renderToolExtra }: Props) {
  const { locale } = useI18n()
  const t: Text = (zh, en) => locale === 'zh-CN' ? zh : en
  const [filters, setFilters] = useState<DebugFilters>(emptyDebugFilters)
  const [detail, setDetail] = useState<Detail>({ kind: 'list' })
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [receipts, setReceipts] = useState<Record<string, DebugSimulationReceipt[]>>({})
  const [roundTab, setRoundTab] = useState<DebugRoundTab>('request')
  const [editingRound, setEditingRound] = useState(false)
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  const cardNodes = useRef(new Map<string, HTMLButtonElement>())
  const tabNodes = useRef(new Map<DebugRoundTab, HTMLButtonElement>())
  const detailTitle = useRef<HTMLHeadingElement>(null)
  const lastRequest = useRef<DebugOpenRequest | null>(null)
  const lastSurface = useRef(surface)
  const lastSession = useRef(sessionId)
  const editorId = useId()
  const tool = detail.kind === 'tool' ? records.calls.find(call => call.id === detail.id) : undefined
  const round = detail.kind === 'round' ? records.rounds.find(item => item.id === detail.id) : tool ? records.rounds.find(item => item.id === tool.roundId) : undefined
  const callNames = useMemo(() => [...new Set(records.calls.map(call => call.name))].sort(), [records.calls])
  const turns = useMemo(() => [...new Map(records.rounds.map(item => [item.turnId, item.turnOrdinal])).entries()], [records.rounds])
  const filteredCalls = filterDebugCalls(records.calls, filters)
  const filteredRounds = filterDebugRounds(records.rounds, filters)

  useEffect(() => {
    if (lastSession.current === sessionId) return
    lastSession.current = sessionId
    setDetail({ kind: 'list' })
    setFilters(emptyDebugFilters)
    setHighlightId(null)
    setPendingFocus(null)
    setEditingRound(false)
  }, [sessionId])

  useEffect(() => {
    if (lastSurface.current !== surface) {
      lastSurface.current = surface
      setDetail({ kind: 'list' })
      setFilters(emptyDebugFilters)
      setHighlightId(null)
    }
  }, [surface])

  useEffect(() => {
    if (detail.kind === 'tool' && !tool || detail.kind === 'round' && !round) {
      setDetail({ kind: 'list' })
      setFilters(emptyDebugFilters)
      setHighlightId(null)
    }
  }, [detail, tool, round])

  useEffect(() => {
    if (filters.turnId && !turns.some(([id]) => id === filters.turnId)) setFilters(emptyDebugFilters)
  }, [filters.turnId, turns])

  useEffect(() => {
    if (!request || request === lastRequest.current) return
    const exists = request.kind === 'tool' ? records.calls.some(call => call.id === request.id) : records.rounds.some(item => item.id === request.id)
    if (!exists) return
    lastRequest.current = request
    setFilters(emptyDebugFilters)
    setDetail({ kind: 'list' })
    setHighlightId(request.id)
    setPendingFocus(request.id)
  }, [request, records])

  useEffect(() => {
    if (!pendingFocus || detail.kind !== 'list') return
    const node = cardNodes.current.get(pendingFocus)
    if (!node) return
    node.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    node.focus({ preventScroll: true })
    setPendingFocus(null)
  }, [pendingFocus, detail, filteredCalls, filteredRounds])

  useEffect(() => {
    if (detail.kind === 'list') return
    detailTitle.current?.focus({ preventScroll: true })
    detailTitle.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [detail])

  const openTool = (call: DebugToolCall, fromRound?: string) => setDetail({ kind: 'tool', id: call.id, fromRound })
  const openRound = (item: DebugRound) => { setDetail({ kind: 'round', id: item.id }); setRoundTab('request'); setEditingRound(false) }
  const back = () => {
    if (detail.kind === 'tool' && detail.fromRound) {
      setDetail({ kind: 'round', id: detail.fromRound })
    } else {
      if (detail.kind !== 'list') { setHighlightId(detail.id); setPendingFocus(detail.id) }
      setDetail({ kind: 'list' })
    }
  }
  const duration = (value: number | null) => value === null ? t('未记录', 'Not recorded') : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`
  const execution = (ordinal: number) => t(`第 ${ordinal} 次执行`, `Execution ${ordinal}`)
  const updateFilter = <K extends keyof DebugFilters>(key: K, value: DebugFilters[K]) => setFilters(current => ({ ...current, [key]: value }))
  const artifact = (item: DebugRound | DebugToolCall) => item.source !== 'fixture' ? null : ['R03', 'R04'].includes(item.sourceRoundId) ? 'brief' : item.sourceRoundId === 'R09' ? 'sources' : item.sourceRoundId === 'R10' ? 'outline' : null
  const artifactButton = (item: DebugRound | DebugToolCall) => {
    const id = artifact(item)
    return id && onArtifact ? <button type="button" className="debug-text-button" onClick={() => onArtifact(id)}><FileText size={13} />{id === 'brief' ? t('预览需求简报', 'Preview brief') : id === 'sources' ? t('预览资料与引用', 'Preview sources') : t('预览逐页大纲', 'Preview outline')}<ArrowUpRight size={12} /></button> : null
  }
  const simulate = (kind: 'tool' | 'round', id: string, value: Record<string, unknown>) => {
    const receipt = createDebugSimulationReceipt(kind, id, value, crypto.randomUUID(), Date.now())
    setReceipts(current => ({ ...current, [id]: [...current[id] ?? [], receipt] }))
  }
  const receiptList = (id: string) => receipts[id]?.length ? <DetailSection title={t('本地模拟记录', 'Local simulations')} aside={<span>{receipts[id]!.length}</span>}>
    <ol className="debug-receipts">{receipts[id]!.map((receipt, index) => <li key={receipt.id}><details open={index === receipts[id]!.length - 1}><summary><FlaskConical size={13} /><strong>{t(`模拟请求 ${index + 1}`, `Simulated request ${index + 1}`)}</strong><time>{new Date(receipt.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><ChevronDown size={12} /></summary><p>{t('已生成请求预览，未执行真实工具或模型；原始记录保持不变。', 'Request preview created. No real tool or model ran; the original record is unchanged.')}</p><JsonView value={receipt.request} empty="" /></details></li>)}</ol>
  </DetailSection> : null

  const renderEditor = (kind: 'tool' | 'round', id: string, original: Record<string, unknown>, disabled: boolean) => {
    const text = drafts[id] ?? pretty(original)
    const parsed = parseDebugArguments(text)
    const validRound = kind !== 'round' || parsed.ok && isValidRoundRequest(parsed.value)
    const valid = parsed.ok && validRound
    const changed = text !== pretty(original)
    const error = !parsed.ok ? parsed.error === 'invalid-json' ? t('JSON 格式不正确。', 'Invalid JSON.') : t('参数必须是 JSON 对象，不能是数组或空值。', 'Parameters must be a JSON object, not an array or null.') : !validRound ? t('请求需要 messages 数组（包含 role 和 content）以及 tools 数组。', 'The request needs a messages array with role and content, and a tools array.') : null
    return <div className="debug-editor">
      <label htmlFor={`${editorId}-${kind}`}>{kind === 'tool' ? t('调用参数 · 可编辑', 'Arguments · editable') : t('本轮请求 · 可编辑示例', 'Round request · editable example')}<span>{changed ? t('已修改', 'Modified') : 'JSON'}</span></label>
      <textarea id={`${editorId}-${kind}`} spellCheck={false} value={text} aria-invalid={!valid} aria-describedby={error ? `${editorId}-error` : undefined} onChange={event => setDrafts(current => ({ ...current, [id]: event.target.value }))} />
      {error && <p id={`${editorId}-error`} className="debug-validation-error" role="alert">{error}</p>}
      <div className="debug-editor-actions"><button type="button" className="debug-secondary-button" disabled={!changed} onClick={() => setDrafts(current => ({ ...current, [id]: pretty(original) }))}><RotateCcw size={13} />{t('恢复原始参数', 'Reset')}</button><button type="button" className="debug-primary-button" disabled={!valid || disabled} onClick={() => { if (parsed.ok && validRound && !disabled) simulate(kind, id, kind === 'tool' ? { tool: tool!.name, arguments: parsed.value } : parsed.value) }}><Play size={13} />{kind === 'tool' ? t('模拟重跑', 'Simulate rerun') : t('模拟执行本轮', 'Simulate round')}</button></div>
      <div className="debug-preview-feedback" role="status">{!!receipts[id]?.length && <><FlaskConical size={12} /><span>{t(`已生成 ${receipts[id]!.length} 次模拟请求，可在下方查看请求记录。`, `${receipts[id]!.length} simulated request${receipts[id]!.length === 1 ? '' : 's'} created. See the request records below.`)}</span></>}</div>
      <p className="debug-panel-hint">{disabled ? t('执行中的记录暂不可重跑。', 'Running records cannot be rerun yet.') : t('当前只生成本地请求预览。接通执行服务后，才会实际调用并返回新结果。', 'This creates a local request preview. Real execution and new results require the execution service.')}</p>
    </div>
  }

  return <div className="debug-workbench-panel" aria-label={surface === 'tools' ? t('工具调用调试台', 'Tool debugging workbench') : t('Agent 循环调试台', 'Agent round debugging workbench')}>
    {detail.kind === 'list' ? <>
      <div className="debug-list-toolbar">
        <label className="debug-search"><Search size={14} /><input aria-label={surface === 'tools' ? t('搜索工具调用', 'Search tool calls') : t('搜索 Agent 循环', 'Search Agent rounds')} placeholder={surface === 'tools' ? t('搜索工具名称或调用摘要…', 'Search tool or summary…') : t('搜索轮次或阶段…', 'Search round or stage…')} value={filters.query} onChange={event => updateFilter('query', event.target.value)} /></label>
        {surface === 'tools' && <select className="debug-tool-select" aria-label={t('按工具名称筛选', 'Filter by tool name')} value={filters.name} onChange={event => updateFilter('name', event.target.value)}><option value="">{t('全部工具', 'All tools')}</option>{callNames.map(name => <option key={name} value={name}>{name}</option>)}</select>}
        <div className="debug-filter-row"><select aria-label={t('按执行筛选', 'Filter by execution')} value={filters.turnId} onChange={event => updateFilter('turnId', event.target.value)}><option value="">{t('全部执行', 'All executions')}</option>{turns.map(([id, ordinal]) => <option key={id} value={id}>{execution(ordinal)}</option>)}</select><select aria-label={t('按状态筛选', 'Filter by status')} value={filters.status} onChange={event => updateFilter('status', event.target.value as DebugFilters['status'])}><option value="">{t('全部状态', 'All statuses')}</option>{(['success', 'error', 'running', 'cancelled', 'waiting', 'example'] as const).map(status => <option key={status} value={status}>{statusText(status, t, surface === 'rounds')}</option>)}</select></div>
        <div className="debug-list-caption"><span>{surface === 'tools' ? t(`${filteredCalls.length} 次调用`, `${filteredCalls.length} calls`) : t(`${filteredRounds.length} 轮`, `${filteredRounds.length} rounds`)}</span><span><FlaskConical size={11} />{t('前端示例', 'Frontend samples')}</span></div>
      </div>
      <div className="debug-record-list">
        {surface === 'tools' ? filteredCalls.map(call => <button type="button" key={call.id} ref={node => { if (node) cardNodes.current.set(call.id, node); else cardNodes.current.delete(call.id) }} data-debug-call-id={call.id} className={`debug-record-card ${highlightId === call.id ? 'is-highlighted' : ''}`} onClick={() => openTool(call)}>
          <span className="debug-record-top"><span className={`debug-record-icon is-${call.status}`}><Wrench size={16} /></span><span className="debug-record-heading"><strong>{call.name}</strong><span>{execution(call.turnOrdinal)} · {call.roundLabel} · {call.stageLabel}</span></span><ChevronRight size={14} /></span>
          <p>{call.summary}</p><span className="debug-record-bottom"><Status status={call.status} t={t} /><span><Clock3 size={11} />{duration(call.durationMs)}</span></span>
        </button>) : filteredRounds.map(item => <button type="button" key={item.id} ref={node => { if (node) cardNodes.current.set(item.id, node); else cardNodes.current.delete(item.id) }} data-debug-round-id={item.id} className={`debug-record-card ${highlightId === item.id ? 'is-highlighted' : ''}`} onClick={() => openRound(item)}>
          <span className="debug-record-top"><span className="debug-round-number">{item.label}</span><span className="debug-record-heading"><strong>{item.title}</strong><span>{execution(item.turnOrdinal)} · {item.stageLabel}</span></span><ChevronRight size={14} /></span>
          <p>{item.summary}</p><span className="debug-record-bottom"><Status status={item.status} t={t} round /><span>{t(`${item.calls.length} 次工具调用`, `${item.calls.length} tool calls`)}{item.calls.some(call => call.status === 'error') && t(` · ${item.calls.filter(call => call.status === 'error').length} 失败`, ` · ${item.calls.filter(call => call.status === 'error').length} failed`)}</span></span>
        </button>)}
        {(surface === 'tools' ? filteredCalls : filteredRounds).length === 0 && <div className="debug-panel-empty">{surface === 'tools' ? <Wrench size={24} /> : <BrainCircuit size={24} />}<strong>{(surface === 'tools' ? records.calls : records.rounds).length ? t('没有匹配的记录', 'No matching records') : t('暂无调试记录', 'No debug records yet')}</strong><p>{t('运行一个测试，或调整筛选条件查看记录。', 'Run a test or adjust the filters to see records.')}</p>{Object.values(filters).some(Boolean) && <button type="button" className="debug-text-button" onClick={() => setFilters(emptyDebugFilters)}>{t('清除筛选', 'Clear filters')}</button>}</div>}
      </div>
    </> : <>
      <button type="button" className="debug-back-button" onClick={back}><ArrowLeft size={14} />{detail.kind === 'tool' && detail.fromRound ? t('返回本轮', 'Back to round') : t('返回列表', 'Back to list')}</button>
      {tool ? <>
        <div className="debug-detail-title"><h3 ref={detailTitle} tabIndex={-1}><Wrench size={18} />{tool.name}</h3><Status status={tool.status} t={t} /><p>{tool.summary}</p></div>
        <dl className="debug-record-meta"><div><dt>{t('所属执行', 'Execution')}</dt><dd>{execution(tool.turnOrdinal)}</dd></div><div><dt>{t('Agent 循环', 'Agent round')}</dt><dd>{round ? <button type="button" className="debug-text-button" onClick={() => openRound(round)}>{tool.roundLabel}<ArrowUpRight size={11} /></button> : tool.roundLabel}</dd></div><div><dt>{t('阶段', 'Stage')}</dt><dd>{tool.stageLabel}</dd></div><div><dt>{t('执行时间', 'Duration')}</dt><dd>{duration(tool.durationMs)}</dd></div><div><dt>{t('开始时间', 'Started at')}</dt><dd>{tool.startedAt === null ? t('未记录', 'Not recorded') : new Date(tool.startedAt).toLocaleString(locale)}</dd></div></dl>
        <div className="debug-detail-links">{round && <button type="button" className="debug-text-button" onClick={() => onLocateRound(round)}><LocateFixed size={13} />{t('定位到对话', 'Locate in conversation')}</button>}{artifactButton(tool)}</div>
        {renderEditor('tool', tool.id, tool.arguments, tool.status === 'running')}
        <DetailSection title={t('原始返回结果', 'Original result')} aside={<span>{t('只读', 'Read only')}</span>}>
          {tool.error && <div className="debug-tool-error"><CircleAlert size={14} /><span>{tool.error}</span></div>}
          <JsonView value={tool.result} empty={t('没有记录返回结果。', 'No result was recorded.')} />
        </DetailSection>
        {renderToolExtra?.(tool)}
        {receiptList(tool.id)}
      </> : round ? <>
        <div className="debug-detail-title"><h3 ref={detailTitle} tabIndex={-1}><span className="debug-round-number">{round.label}</span>{round.title}</h3><Status status={round.status} t={t} round /><p>{execution(round.turnOrdinal)} · {round.stageLabel}</p></div>
        <div className="debug-detail-links"><button type="button" className="debug-text-button" onClick={() => onLocateRound(round)}><LocateFixed size={13} />{t('定位到对话', 'Locate in conversation')}</button>{artifactButton(round)}</div>
        <div className="debug-round-tabs" role="tablist" aria-label={t('循环详情', 'Round details')}>{debugRoundTabs.map(tab => <button type="button" role="tab" id={`${editorId}-tab-${tab}`} aria-controls={`${editorId}-panel-${tab}`} aria-selected={roundTab === tab} tabIndex={roundTab === tab ? 0 : -1} key={tab} ref={node => { if (node) tabNodes.current.set(tab, node); else tabNodes.current.delete(tab) }} onClick={() => setRoundTab(tab)} onKeyDown={event => {
          const next = nextDebugRoundTab(tab, event.key)
          if (!next) return
          event.preventDefault()
          setRoundTab(next)
          tabNodes.current.get(next)?.focus()
        }}>{tab === 'request' ? t('模型请求', 'Request') : tab === 'response' ? t('输出与调用', 'Output & tools') : t('Cognitive', 'Cognitive')}</button>)}</div>
        <div role="tabpanel" id={`${editorId}-panel-request`} aria-labelledby={`${editorId}-tab-request`} hidden={roundTab !== 'request'} tabIndex={0}>
          <p className="debug-provenance"><FlaskConical size={13} />{round.promptMessages.some(message => message.fidelity === 'illustrative') ? t('以下为示例组装的请求，不是实际发送给模型的完整原始请求。', 'This is an illustrative request, not the complete original request sent to a model.') : t('显示已记录的请求字段；未记录字段不会补造。', 'Showing recorded request fields; missing fields are not fabricated.')}</p>
          <dl className="debug-record-meta"><div><dt>{t('模型', 'Model')}</dt><dd>{round.model ?? t('未记录', 'Not recorded')}</dd></div><div><dt>{t('执行时间', 'Duration')}</dt><dd>{duration(round.durationMs)}</dd></div></dl>
          <DetailSection title={t('Prompt 消息', 'Prompt messages')} aside={<span>{round.promptMessages.length}</span>}>
            {round.promptMessages.length ? <ol className="debug-prompt-messages">{round.promptMessages.map((message, index) => <li key={message.id}><details open><summary><code>{message.role}</code><strong>{message.label}</strong><span>{index + 1}</span><ChevronDown size={12} /></summary><pre>{message.content}</pre></details></li>)}</ol> : <p className="debug-empty-value">{t('未记录 Prompt。', 'Prompt was not recorded.')}</p>}
          </DetailSection>
          <DetailSection title={t('工具定义', 'Tool definitions')} aside={<span>{round.toolDefinitions.length}</span>}>
            <div className="debug-tool-definitions">{round.toolDefinitions.map(definition => <details key={definition.name}><summary><Braces size={13} /><code>{definition.name}</code><ChevronDown size={12} /></summary><p>{definition.description}</p><JsonView value={definition.schema} empty={t('未记录此工具的完整 Schema。', 'The complete tool schema was not recorded.')} /></details>)}</div>
          </DetailSection>
          <details className="debug-model-options"><summary>{t('模型选项', 'Model options')}<ChevronDown size={12} /></summary><JsonView value={round.modelOptions} empty={t('未记录模型选项。', 'Model options were not recorded.')} /></details>
        </div>
        <div role="tabpanel" id={`${editorId}-panel-response`} aria-labelledby={`${editorId}-tab-response`} hidden={roundTab !== 'response'} tabIndex={0}>
          <DetailSection title={t('模型原始输出', 'Original model output')}><JsonView value={round.output} empty={t('未记录模型原始输出。下方展示可追溯的工具调用记录。', 'Original model output was not recorded. Available tool calls appear below.')} /></DetailSection>
          <DetailSection title={t('返回的工具调用与结果', 'Returned tool calls and results')} aside={<span>{round.calls.length}</span>}>
            <div className="debug-round-calls">{round.calls.map(call => <button type="button" key={call.id} onClick={() => openTool(call, round.id)}><Wrench size={14} /><span><strong>{call.name}</strong><small>{call.summary}</small></span><Status status={call.status} t={t} /><ChevronRight size={12} /></button>)}</div>
            {!round.calls.length && <p className="debug-empty-value">{t('本轮还没有工具调用记录。', 'No tool calls are recorded for this round.')}</p>}
          </DetailSection>
        </div>
        <div role="tabpanel" id={`${editorId}-panel-state`} aria-labelledby={`${editorId}-tab-state`} hidden={roundTab !== 'state'} tabIndex={0}>
          <DetailSection title={t('本轮决策', 'Round decision')}><p className="debug-decision">{round.decision || t('未记录决策。', 'No decision was recorded.')}</p>{round.evidence.length > 0 && <ul className="debug-evidence">{round.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>}</DetailSection>
          <DetailSection title={t('执行前状态', 'State before')}><JsonView value={round.beforeState} empty={t('未记录完整状态快照。', 'A complete state snapshot was not recorded.')} /></DetailSection>
          <DetailSection title={t('执行后状态', 'State after')}><JsonView value={round.afterState} empty={t('未记录完整状态快照。', 'A complete state snapshot was not recorded.')} /></DetailSection>
        </div>
        <div className="debug-round-replay"><button type="button" className="debug-secondary-button" aria-expanded={editingRound} onClick={() => setEditingRound(value => !value)}><Braces size={13} />{t('编辑请求并模拟本轮', 'Edit request & simulate round')}<ChevronDown size={12} /></button>{editingRound && renderEditor('round', round.id, roundRequest(round), round.status === 'running')}</div>
        {receiptList(round.id)}
      </> : <p className="debug-empty-value">{t('记录已不可用，请返回列表。', 'This record is unavailable. Return to the list.')}</p>}
    </>}
  </div>
}
