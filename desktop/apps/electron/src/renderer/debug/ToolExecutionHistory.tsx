import { useState } from 'react'
import { GitCompareArrows, History, RotateCcw } from 'lucide-react'
import { useDebugText } from './DebugSessionProvider'
import { comparisonText, toolDifference } from './tool-comparison'
import { TOOL_HISTORY_LIMIT, type ToolExecution } from './useToolExecution'
import { duration } from './TraceParts'
import { toolExecutionArguments } from './tool-argument-draft'
import type { TraceToolCall } from './types'

function Difference({ title, before, after, baseline, current }: { title: string; before: unknown; after: unknown; baseline: string; current: string }) {
  const text = useDebugText()
  const diff = toolDifference(comparisonText(before), comparisonText(after))
  const type = (value: unknown) => {
    if (value === null) return 'null'
    return Array.isArray(value) ? 'array' : typeof value
  }
  const same = diff.same && type(before) === type(after)
  return <section className="debug-tool-difference">
    <h5>{title}<span>{text(same ? 'toolWorkbench.identical' : 'toolWorkbench.changed')}</span></h5>
    {same ? <p className="debug-muted">{text('toolWorkbench.noDifference')}</p> : <div className="debug-tool-diff-pair">
      {(['before', 'after'] as const).map(side => {
        const value = diff[side]
        const end = value.length - diff.suffix
        return <div key={side} className={`debug-tool-diff-side is-${side}`}><strong>{side === 'before' ? baseline : current}<code>{type(side === 'before' ? before : after)}</code></strong>
          <pre>{value.slice(0, diff.prefix)}<mark>{value.slice(diff.prefix, end)}</mark>{value.slice(end)}</pre>
        </div>
      })}
    </div>}
  </section>
}

export function ToolExecutionHistory({ call, runs, onReuse }: { call: TraceToolCall; runs: ToolExecution[]; onReuse: (argumentsValue: Record<string, unknown>) => void }) {
  const text = useDebugText()
  const [selectedId, setSelectedId] = useState('latest')
  const [baselineId, setBaselineId] = useState('original')
  const [tab, setTab] = useState<'result' | 'arguments' | 'compare'>('result')
  const [lastRunId, setLastRunId] = useState(runs.at(-1)?.id)
  if (lastRunId !== runs.at(-1)?.id) {
    setLastRunId(runs.at(-1)?.id)
    setSelectedId('latest')
    setTab('result')
  }
  const selected = runs.find(run => run.id === selectedId) ?? runs.at(-1)
  if (!selected) return null
  const baselines = runs.filter(run => run.id !== selected.id && run.status !== 'running')
  const baseline = baselines.find(run => run.id === baselineId)
  const baselineLabel = baseline ? text('toolWorkbench.runNumber', { n: baseline.ordinal }) : text('toolWorkbench.originalCall')
  const currentLabel = text('toolWorkbench.runNumber', { n: selected.ordinal })
  const status = (run: ToolExecution) => {
    if (run.status === 'running') return text('toolExecuting')
    if (run.status === 'error') return text('toolWorkbench.requestFailed')
    return text(run.response?.result.success ? 'success' : 'failed')
  }
  const output = (run: ToolExecution) => {
    if (run.error) return { requestError: run.error }
    return run.response?.result.error ? { output: run.response.result.tool_result, error: run.response.result.error } : run.response?.result.tool_result
  }
  const originalOutput = call.error ? { output: call.result, error: call.error } : call.result
  const baselineOutput = baseline ? output(baseline) : originalOutput
  const baselineArguments = baseline ? baseline.input.arguments : toolExecutionArguments(call.arguments) ?? call.arguments
  const canCompareResult = selected.status !== 'running' && (baseline ? baseline.status !== 'running' : call.hasResult)
  const tabs = { result: text('result'), arguments: text('toolSubmittedArguments'), compare: text('toolWorkbench.compare') }
  let statusClass = selected.response?.result.success ? 'success' : 'error'
  if (selected.status === 'running') statusClass = 'running'
  return <section className="debug-inspector-card debug-tool-test-result" aria-label={text('toolWorkbench.history')} aria-busy={selected.status === 'running'}>
    <div className="debug-inspector-heading"><History size={15} /><h4>{text('toolWorkbench.history')}</h4><span className="debug-inspector-caption">{runs.length}</span></div>
    <div className="debug-inspector-body">
      <div className="debug-tool-history-toolbar">
        <label><span>{text('toolWorkbench.selectedTest')}</span><select aria-label={text('toolWorkbench.selectedTest')} value={selectedId === 'latest' || !runs.some(run => run.id === selectedId) ? 'latest' : selected.id} onChange={event => setSelectedId(event.target.value)}>
          <option value="latest">{text('toolWorkbench.latestTest')}</option>
          {[...runs].reverse().map(run => <option key={run.id} value={run.id}>{text('toolWorkbench.runNumber', { n: run.ordinal })} · {status(run)} · {new Date(run.startedAt).toLocaleTimeString()}</option>)}
        </select></label>
        <button type="button" onClick={() => onReuse(selected.input.arguments)}><RotateCcw size={12} />{text('toolWorkbench.reuseArguments')}</button>
      </div>
      <div className="debug-tool-test-meta" role="status"><strong className={`is-${statusClass}`}>{currentLabel} · {status(selected)}</strong>
        <span>{new Date(selected.startedAt).toLocaleTimeString()} · {duration(selected.response?.durationMs ?? null)}</span>
      </div>
      <div className="debug-tool-tabs" role="tablist" aria-label={text('toolWorkbench.testDetails')}>
        {(['result', 'arguments', 'compare'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value === 'compare' ? <GitCompareArrows size={12} /> : null}{tabs[value]}</button>)}
      </div>
      <div role="tabpanel">
        {tab === 'result' ? <>
          {selected.status === 'running' ? <p className="debug-tool-editor-note">{text('toolExecuting')}</p> : null}
          {selected.error ? <p role="alert" className="debug-tool-editor-error">{text('toolExecutionRequestFailed')} {selected.error}</p> : null}
          {selected.response?.result.error ? <pre role="alert" className="debug-tool-editor-error">{selected.response.result.error}</pre> : null}
          {selected.response ? <pre className="debug-tool-run-output">{comparisonText(selected.response.result.tool_result)}</pre> : null}
          <details className="debug-tool-submitted"><summary>{text('toolSubmittedArguments')}</summary><pre>{JSON.stringify(selected.input.arguments, null, 2)}</pre></details>
        </> : null}
        {tab === 'arguments' ? <>
          <pre className="debug-tool-run-output">{JSON.stringify(selected.input.arguments, null, 2)}</pre>
          {selected.response ? <details className="debug-tool-submitted"><summary>{text('toolWorkbench.effectiveArguments')}</summary><pre>{JSON.stringify(selected.response.result.tool_arguments, null, 2)}</pre></details> : null}
        </> : null}
        {tab === 'compare' ? <>
          <label className="debug-tool-baseline">{text('toolWorkbench.baseline')}<select aria-label={text('toolWorkbench.baseline')} value={baseline?.id ?? 'original'} onChange={event => setBaselineId(event.target.value)}>
            <option value="original">{text('toolWorkbench.originalCall')}</option>
            {[...baselines].reverse().map(run => <option key={run.id} value={run.id}>{text('toolWorkbench.runNumber', { n: run.ordinal })} · {status(run)}</option>)}
          </select></label>
          <Difference title={text('arguments')} before={baselineArguments} after={selected.input.arguments} baseline={baselineLabel} current={currentLabel} />
          {canCompareResult ? <Difference title={text('result')} before={baselineOutput} after={output(selected)} baseline={baselineLabel} current={currentLabel} />
            : <p className="debug-tool-editor-note">{text('toolWorkbench.resultPending')}</p>}
        </> : null}
      </div>
      <p className="debug-tool-editor-note">{text('toolWorkbench.retention', { n: TOOL_HISTORY_LIMIT })}</p>
    </div>
  </section>
}
