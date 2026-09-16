import { useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { currentStreamingAtom } from '@/atoms/agent'
import { Activity, ArrowDownLeft, ArrowUpRight, ChartNoAxesCombined, Check, ChevronRight, CircleHelp, Layers3, RefreshCw, Repeat2, Wrench, X, XCircle, Zap } from 'lucide-react'
import type { SessionWorkbenchExtensionProps } from '@/components/app/DesktopAppExtensions'
import { WorkbenchToolHeader, WorkbenchToolScrollArea, WorkbenchToolSurface } from '@/components/app/WorkbenchToolPrimitives'
import { useDebugSession, useDebugText } from './DebugSessionProvider'
import { buildExecutionOverview, type UsageTotal } from './execution-overview'
import { userInputText } from './trace-presentation'
import { turnLabel } from './TraceParts'
import './execution-overview.css'

function usageLabel(total: UsageTotal) {
  if (total.value === null) return '—'
  return `${total.partial ? '≥ ' : ''}${total.value.toLocaleString()}`
}

function Overview({ onClose }: SessionWorkbenchExtensionProps) {
  const debug = useDebugSession()
  const text = useDebugText()
  const streaming = Boolean(useAtomValue(currentStreamingAtom))
  const [scope, setScope] = useState('latest')
  const ordered = useMemo(() => [...debug.turns].sort((a, b) => b.sessionOrdinal - a.sessionOrdinal || b.id.localeCompare(a.id)), [debug.turns])
  const selected = scope === 'latest' ? ordered[0] : ordered.find(turn => turn.id === scope)
  const turns = useMemo(() => scope === 'session' ? ordered : ordered.filter(turn => turn.id === selected?.id), [scope, ordered, selected?.id])
  const overview = useMemo(() => buildExecutionOverview(turns, debug.records), [turns, debug.records])
  const { usage, tools, rounds, stages } = overview
  const input = userInputText(selected?.userInput)
  const running = streaming && turns.some(turn => turn.id === ordered[0]?.id)
  const pending = debug.loading && !debug.turns.length
  const noData = !debug.loading && !debug.error && !turns.length
  const tokenSum = (usage.inputTokens.value ?? 0) + (usage.outputTokens.value ?? 0)
  const showTokenBar = usage.inputTokens.value !== null && usage.outputTokens.value !== null && tokenSum > 0
  const successRate = tools.success + tools.failed > 0 ? tools.success / (tools.success + tools.failed) : null
  const maxStageRounds = Math.max(1, ...stages.map(stage => stage.rounds))
  const percentage = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`
  const scopeChange = (value: string) => {
    setScope(value)
    if (value === 'session') debug.loadAll()
  }

  return <WorkbenchToolSurface testId="desktop-debug-overview" className="debug-overview-surface">
    <WorkbenchToolHeader title={text('overview.title')} icon={<ChartNoAxesCombined size={16} />}
      actions={<>
        <button type="button" className="debug-overview-icon-button" aria-label={text('overview.refresh')} title={text('overview.refresh')} disabled={debug.loading} onClick={debug.refresh}><RefreshCw size={14} className={debug.loading ? 'is-refreshing' : undefined} /></button>
        <button type="button" className="debug-overview-icon-button" aria-label={text('closePanel')} onClick={onClose}><X size={16} /></button>
      </>} />
    <WorkbenchToolScrollArea className="debug-overview">
      <div className="debug-overview-scope">
        <label htmlFor="debug-overview-scope">{text('overview.scope')}</label>
        <select id="debug-overview-scope" value={scope} onChange={event => scopeChange(event.target.value)}>
          <option value="latest">{text('overview.latestTurn')}{ordered[0] ? ` · Turn ${turnLabel(ordered[0].sessionOrdinal)}` : ''}</option>
          <option value="session">{text('overview.entireSession')}</option>
          {ordered.map(turn => <option key={turn.id} value={turn.id}>Turn {turnLabel(turn.sessionOrdinal)} · {(userInputText(turn.userInput) ?? text('userInputNotRecorded')).slice(0, 60)}</option>)}
        </select>
      </div>
      {debug.hasMore && scope !== 'session' ? <button type="button" className="debug-overview-load" disabled={debug.loading} onClick={debug.loadMore}>{text('loadEarlierRecords')}</button> : null}
      {debug.error ? <div role="alert" className="debug-overview-notice">{text('readFailed')} · {debug.error}</div> : null}
      {pending ? <div className="debug-overview-empty" role="status"><Activity size={24} /><p>{text('loadingExecutionRecords')}</p></div> : null}
      {noData ? <div className="debug-overview-empty"><ChartNoAxesCombined size={30} /><h3>{text('overview.empty')}</h3><p>{text('overview.emptyHint')}</p></div> : null}
      {!pending && !noData && turns.length > 0 ? <>
        <div className="debug-overview-context">
          <div><span className={`debug-overview-state ${running ? 'is-live' : ''}`}><i />{text(running ? 'overview.live' : 'overview.recorded')}</span>
            {scope === 'session' ? <span>{text('overview.turnCount', { n: turns.length })}</span> : <span>Turn {turnLabel(selected!.sessionOrdinal)}</span>}
          </div>
          {input ? <p title={input}>{input}</p> : null}
          {scope === 'session' && debug.hasMore ? <p role="status" className="debug-overview-notice">{text('overview.partialSession', { n: turns.length })}</p> : null}
        </div>

        <section className="debug-overview-token-card" aria-label={text('overview.tokenUsage')}>
          <div className="debug-overview-section-heading"><span><Zap size={14} />{text('overview.totalTokens')}</span><span className="debug-overview-unit">TOKENS</span></div>
          <div className="debug-overview-token-total" data-metric="totalTokens">{usageLabel(usage.totalTokens)}</div>
          <div className="debug-overview-token-bar" aria-hidden="true">
            {showTokenBar ? <><span style={{ width: `${usage.inputTokens.value! / tokenSum * 100}%` }} /><span style={{ width: `${usage.outputTokens.value! / tokenSum * 100}%` }} /></> : null}
          </div>
          <dl className="debug-overview-token-split">
            <div><dt><ArrowDownLeft size={13} />{text('inputTokens')}</dt><dd data-metric="inputTokens">{usageLabel(usage.inputTokens)}</dd></div>
            <div><dt><ArrowUpRight size={13} />{text('outputTokens')}</dt><dd data-metric="outputTokens">{usageLabel(usage.outputTokens)}</dd></div>
          </dl>
          <div className="debug-overview-cache">
            <dl>
              <div><dt>{text('overview.cacheRead')}</dt><dd data-metric="cachedInputTokens">{usageLabel(usage.cachedInputTokens)}</dd></div>
              <div><dt>{text('overview.cacheRate')}</dt><dd data-metric="cacheRate">{percentage(overview.cacheRate)}</dd></div>
              <div><dt>{text('overview.cacheWrite')}</dt><dd data-metric="cacheCreationInputTokens">{usageLabel(usage.cacheCreationInputTokens)}</dd></div>
            </dl>
            {overview.cacheRecordedRounds < rounds.length ? <p>{text('overview.cacheCoverage', { n: overview.cacheRecordedRounds, total: rounds.length })}</p> : null}
          </div>
        </section>

        <dl className="debug-overview-kpis">
          <div><dt><Repeat2 size={14} />{text('overview.modelCalls')}</dt><dd data-metric="rounds">{rounds.length.toLocaleString()}</dd><small>rounds</small></div>
          <div><dt><Wrench size={14} />{text('toolCalls')}</dt><dd data-metric="tools">{tools.total.toLocaleString()}</dd><small>{text('overview.invocations')}</small></div>
          <div><dt><Layers3 size={14} />{text('overview.modeStages')}</dt><dd data-metric="stages">{overview.stageCount.toLocaleString()}</dd><small>{text('overview.modeCount', { n: overview.modes })}</small></div>
        </dl>

        <section className="debug-overview-section" aria-label={text('overview.toolResults')}>
          <h3><Wrench size={15} />{text('overview.toolResults')}<span>{text('overview.callCount', { n: tools.total })}</span></h3>
          <div className="debug-overview-success-rate"><span>{text('overview.successRate')}</span><strong>{percentage(successRate)}</strong></div>
          <div className="debug-overview-outcome-bar" aria-hidden="true">
            {tools.total > 0 ? <>
              <span className="is-success" style={{ width: `${tools.success / tools.total * 100}%` }} />
              <span className="is-failed" style={{ width: `${tools.failed / tools.total * 100}%` }} />
              <span className="is-unknown" style={{ width: `${tools.unknown / tools.total * 100}%` }} />
            </> : null}
          </div>
          <dl className="debug-overview-outcomes">
            <div className="is-success"><dt><Check size={13} />{text('success')}</dt><dd data-metric="toolSuccess">{tools.success.toLocaleString()}</dd></div>
            <div className="is-failed"><dt><XCircle size={13} />{text('failed')}</dt><dd data-metric="toolFailed">{tools.failed.toLocaleString()}</dd></div>
            <div className="is-unknown"><dt><CircleHelp size={13} />{text('overview.unknown')}</dt><dd data-metric="toolUnknown">{tools.unknown.toLocaleString()}</dd></div>
          </dl>
        </section>
        <section className="debug-overview-section" aria-label={text('overview.stageDistribution')}>
          <h3><Layers3 size={15} />{text('overview.stageDistribution')}<span>{text('overview.roundCount', { n: rounds.length })}</span></h3>
          <div className="debug-overview-stage-list">
            {stages.map(stage => <button type="button" key={stage.key} className="debug-overview-stage" onClick={() => debug.inspect('rounds', stage.firstRoundId)}>
              <div><code>{stage.mode ?? '?'}-{stage.stage ?? '?'}</code><strong>{stage.rounds}<small> rounds</small></strong><ChevronRight size={12} /></div>
              <div className="debug-overview-stage-track" aria-hidden="true"><span style={{ width: `${stage.rounds / maxStageRounds * 100}%` }} /></div>
              <span>{text('overview.stageVisits', { n: stage.visits })}</span>
            </button>)}
            {!stages.length ? <p className="debug-overview-footnote">{text('overview.noRounds')}</p> : null}
          </div>
        </section>


        {overview.issues.length || tools.unmatchedResults ? <p className="debug-overview-notice">{text('overview.incompleteRecords')}</p> : null}
        <details className="debug-overview-method"><summary>{text('overview.methodTitle')}</summary>
          <p>{text('overview.method')}</p><p>{text('overview.cacheIncluded')}</p><p>{text('overview.successRateHint')}</p>
        </details>
      </> : null}
    </WorkbenchToolScrollArea>
  </WorkbenchToolSurface>
}

export function DebugOverviewPanel(props: SessionWorkbenchExtensionProps) {
  return <Overview key={props.sessionId} {...props} />
}
