import { useEffect, useMemo, useRef, useState } from 'react'
import { atom, useAtomValue } from 'jotai'
import { Code2, Copy, FlaskConical, Info, RefreshCw, Square } from 'lucide-react'
import { buildAmphiClient } from '@/atoms/backend'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { MessageThinking } from '@/components/amphi/MessageThinking'
import type { CreateDebugModelRun, DebugModelRequest, DebugModelRun, DebugPromptResponse } from '@shared/debug-model-types'
import { useDebugDraft } from './DebugDrafts'
import { useDebugText } from './DebugSessionProvider'
import { ModelExperimentDialog } from './ModelExperimentDialog'
import { ModelRequestContents } from './ModelRequestContents'
import { buildTraceRecords } from './trace-records'
import { JsonRecord, RoundMetrics, RoundResponse, roundLabel, turnLabel } from './TraceParts'
import type { TraceRound } from './types'
import './round-model-call.css'

export const debugModelClientAtom = atom(get => buildAmphiClient(get))

function ExperimentResult({ run, round }: { run: DebugModelRun; round: TraceRound }) {
  const text = useDebugText()
  const measured = useMemo(() => buildTraceRecords([{
    id: run.id, sessionId: run.sessionId, sessionOrdinal: round.turnOrdinal, model: run.request.model,
    status: run.status, durationMs: null, otaContext: null,
    otaRecords: [{ usage: run.usage, model_duration_ms: run.durationMs }],
  }]).rounds[0]!, [run, round.turnOrdinal])
  return <div className="debug-call-result">
    <div className="debug-call-result-meta"><span>{text(`modelCall.status.${run.status}`)}</span><code>{run.request.model}</code></div>
    <RoundMetrics round={measured} />
    {run.error ? <p role="alert" className="debug-notice">{run.error}</p> : null}
    {run.reasoning ? <details className="debug-thinking"><summary>Thinking</summary><MessageThinking thinking={run.reasoning} /></details> : null}
    {run.content ? <MarkdownMessage content={run.content} density="compact" /> : null}
    {run.status === 'running' && !run.content && !run.reasoning ? <p role="status">{text('modelCall.waiting')}</p> : null}
    {run.toolCalls.length ? <JsonRecord title={text('returnedToolCalls')} value={run.toolCalls} /> : null}
    {run.retries.length ? <JsonRecord title={text('modelCall.retries')} value={run.retries} open={false} /> : null}
    <JsonRecord title={text('modelCall.submittedRequest')} value={run.request} open={false} />
  </div>
}

export function RoundModelCall({ round }: { round: TraceRound }) {
  const text = useDebugText()
  const client = useAtomValue(debugModelClientAtom)
  const [assembly, setAssembly] = useDebugDraft<DebugPromptResponse | null>(`assembly:${round.id}`, () => null)
  const [runs, setRuns] = useDebugDraft<DebugModelRun[]>(`runs:${round.id}`, () => [])
  const [pending, setPending] = useDebugDraft<{ serialized: string; body: CreateDebugModelRun } | null>(`pending:${round.id}`, () => null)
  const [experimentOpen, setExperimentOpen] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [finishedRevision, setFinishedRevision] = useState(-1)
  const [assemblyError, setAssemblyError] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [streamRevision, setStreamRevision] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [selected, setSelected] = useState('')
  const pendingSubmission = useRef(pending)
  const submissionLock = useRef(false)
  const current = useRef(true)
  useEffect(() => { current.current = true; return () => { current.current = false } }, [])
  const loading = Boolean(client && round.mode && round.stage && (!assembly || revision > 0) && finishedRevision !== revision)
  let assemblyFailure = assemblyError
  if (!client) assemblyFailure = text('modelCall.backendUnavailable')
  else if (!round.mode || !round.stage) assemblyFailure = text('modelCall.scopeMissing')
  const request = useMemo<DebugModelRequest | null>(() => assembly ? {
    model: assembly.item.request.modelId ?? '', providerId: assembly.item.request.providerId,
    protocol: assembly.item.request.protocol, messages: assembly.item.request.messages,
    tools: assembly.item.request.tools, extraBody: assembly.item.request.extraBody ?? {},
  } : null, [assembly])

  useEffect(() => {
    if ((assembly && revision === 0) || finishedRevision === revision) return
    if (!client || !round.mode || !round.stage) return
    const controller = new AbortController()
    const source = { turnId: round.turnId, roundIndex: round.ordinal - 1, mode: round.mode, stage: round.stage }
    void client.assembleDebugPrompt(round.sessionId, source, controller.signal).then(data => {
      if (controller.signal.aborted) return
      if (data.sessionId !== round.sessionId || data.item.turnId !== source.turnId || data.item.roundIndex !== source.roundIndex
        || data.item.mode !== source.mode || data.item.stage !== source.stage || !data.item.revision
        || !Array.isArray(data.item.request.messages) || !Array.isArray(data.item.request.tools)) throw new Error(text('modelCall.invalidResponse'))
      setAssembly(data); setRevision(0); setFinishedRevision(0)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) { setAssemblyError(error instanceof Error ? error.message : String(error)); setFinishedRevision(revision) }
    })
    return () => controller.abort()
  }, [client, round.sessionId, round.turnId, round.ordinal, round.mode, round.stage, assembly, revision, finishedRevision, setAssembly, text])

  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    void client.listDebugModelRuns(round.sessionId, round.turnId, round.ordinal - 1, controller.signal).then(items => {
      if (controller.signal.aborted) return
      if (!Array.isArray(items) || items.some(item => item.sessionId !== round.sessionId || item.source.turnId !== round.turnId || item.source.roundIndex !== round.ordinal - 1)) throw new Error(text('modelCall.invalidResponse'))
      setRuns(existing => {
        const merged = new Map(existing.map(item => [item.id, item]))
        for (const item of items) {
          const previous = merged.get(item.id)
          if (previous && previous.status !== 'running' && item.status === 'running') continue
          merged.set(item.id, item)
        }
        return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      })
    }).catch((error: unknown) => { if (!controller.signal.aborted) setRunError(String(error)) })
    return () => controller.abort()
  }, [client, round.sessionId, round.turnId, round.ordinal, setRuns, text])

  const activeRun = runs.find(run => run.status === 'running')
  const activeRunId = activeRun?.id
  useEffect(() => {
    if (!client || !activeRunId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const update = (run: Omit<DebugModelRun, 'request'>) => {
      if (!controller.signal.aborted) setRuns(items => items.map(item => item.id === run.id ? { ...item, ...run } : item))
    }
    const connect = async () => {
      try {
        await client.watchDebugModelRun(round.sessionId, activeRunId, update, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) return
        try {
          const run = await client.getDebugModelRun(round.sessionId, activeRunId, controller.signal)
          update(run)
          if (run.status !== 'running') return
        } catch { /* The next stream attempt also restores the current snapshot. */ }
        if (!controller.signal.aborted) {
          if (++failures < 3) timer = setTimeout(() => { void connect() }, 1000)
          else setRunError(error instanceof Error ? error.message : String(error))
        }
      }
    }
    void connect()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [client, activeRunId, round.sessionId, setRuns, streamRevision])

  const runOnce = async (draft: Record<string, unknown>) => {
    if (!client || !assembly || submissionLock.current || activeRunId) return
    submissionLock.current = true; setSubmitting(true); setRunError(null)
    try {
      const item = assembly.item
      const source = { turnId: item.turnId, roundIndex: item.roundIndex, mode: item.mode, stage: item.stage, revision: item.revision }
      const serialized = JSON.stringify({ source, request: draft })
      if (pendingSubmission.current?.serialized !== serialized) pendingSubmission.current = {
        serialized, body: { clientRequestId: crypto.randomUUID(), source, request: draft as unknown as DebugModelRequest },
      }
      setPending(pendingSubmission.current)
      const result = await client.createDebugModelRun(round.sessionId, pendingSubmission.current.body)
      if (result.sessionId !== round.sessionId || result.source.turnId !== round.turnId || result.source.roundIndex !== round.ordinal - 1) throw new Error(text('modelCall.invalidResponse'))
      setRuns(items => [...items.filter(item => item.id !== result.id), result])
      if (current.current) setSelected(result.id)
      pendingSubmission.current = null
      setPending(null)
    } catch (error) { if (current.current) setRunError(error instanceof Error ? error.message : String(error)) }
    finally { submissionLock.current = false; if (current.current) setSubmitting(false) }
  }
  const cancel = async () => {
    if (!client || !activeRunId) return
    setCancelling(true); setRunError(null)
    try {
      const result = await client.cancelDebugModelRun(round.sessionId, activeRunId)
      if (current.current) setRuns(items => items.map(item => item.id === result.id ? result : item))
    } catch (error) { if (current.current) setRunError(String(error)) }
    finally { if (current.current) setCancelling(false) }
  }
  const selectedRun = runs.find(run => run.id === selected) ?? activeRun ?? runs[runs.length - 1]
  let experimentHint = text('modelCall.experimentEntryHint')
  if (activeRunId || submitting) experimentHint = text('modelCall.status.running')
  else if (runs.length) experimentHint = text('modelCall.experimentCount', { n: runs.length })
  let requestContent
  if (request) {
    if (showRaw) requestContent = <div className="debug-request-raw"><div><strong>{text('modelCall.completeRequest')}</strong><button type="button" onClick={() => setShowRaw(false)}>{text('modelCall.structuredView')}</button></div><pre>{JSON.stringify(request, null, 2)}</pre></div>
    else requestContent = <ModelRequestContents request={request} stateKey={round.id} />
  }
  return <div className="debug-round-call">
    <section className="debug-inspector-card">
      <div className="debug-call-heading"><strong>{text('modelRequest')}</strong>
        <span title={text('modelCall.assembledNotice')} aria-label={text('modelCall.assembledNotice')}><Info size={14} /></span>
        <button type="button" disabled={loading} title={text('modelCall.reassemble')} aria-label={text('modelCall.reassemble')} onClick={() => { setAssemblyError(null); setRevision(value => value + 1) }}><RefreshCw size={14} className={loading ? 'is-refreshing' : undefined} /></button>
        {request ? <button type="button" aria-pressed={showRaw} aria-label={text(showRaw ? 'modelCall.structuredView' : 'modelCall.viewJson')} title={text(showRaw ? 'modelCall.structuredView' : 'modelCall.viewJson')} onClick={() => { setShowRaw(value => !value) }}><Code2 size={14} /></button> : null}
        {request ? <button type="button" aria-label={text('modelCall.copy')} title={text('modelCall.copy')} onClick={() => { void navigator.clipboard.writeText(JSON.stringify(request, null, 2)).catch(error => setAssemblyError(String(error))) }}><Copy size={14} /></button> : null}
      </div>
      <div className="debug-call-body">
        <div className="debug-call-source"><strong>Turn {turnLabel(round.turnOrdinal)} · {roundLabel(round)}</strong><code>{round.mode} / {round.stage}</code></div>
        {assemblyFailure ? <p role="alert" className="debug-notice">{assemblyFailure}</p> : null}
        {loading ? <p role="status">{text('modelCall.assembling')}</p> : null}
        {request ? <>
          <div className="debug-call-request-meta"><code>{request.model || text('notRecorded')}</code><span>{text('modelCall.assembledRequest')}</span>
            {assembly?.item.modelSource === 'current' ? <span>{text('modelCall.currentModelFallback')}</span> : null}</div>
          {requestContent}
        </> : null}
      </div>
    </section>
    <section className="debug-inspector-card">
      <div className="debug-call-heading"><strong>{text('modelOutput')}</strong><span>{text('modelCall.historicalOutput')}</span></div>
      <div className="debug-call-body"><RoundResponse round={round} />
        {round.calls.length ? <JsonRecord title={text('returnedToolCalls')} value={round.calls.map(call => call.rawCall)} open={false} /> : null}
      </div>
    </section>
    {request ? <button type="button" className="debug-experiment-entry" aria-label={text('modelCall.experimentWorkspace')} onClick={() => setExperimentOpen(true)}>
      <FlaskConical size={16} /><span>{text('modelCall.experimentWorkspace')}</span>
      <span>{experimentHint}</span>
    </button> : null}
    {experimentOpen && request ? <ModelExperimentDialog round={round} request={request} running={submitting || Boolean(activeRunId) || loading}
      onRun={draft => { void runOnce(draft) }} onClose={() => setExperimentOpen(false)}>
      <div className="debug-call-heading"><strong>{text('modelCall.experimentResults')}</strong>
        {runs.length ? <select aria-label={text('modelCall.resultSelection')} value={selectedRun?.id ?? ''} onChange={event => setSelected(event.target.value)}>
          {runs.map((run, index) => <option key={run.id} value={run.id}>{text('modelCall.experiment', { n: index + 1 })} · {text(`modelCall.status.${run.status}`)}</option>)}
        </select> : null}
        {activeRunId ? <button type="button" disabled={cancelling} onClick={() => { void cancel() }}><Square size={12} />{text('modelCall.cancel')}</button> : null}
      </div>
      <div className="debug-experiment-result-body">
        {runError ? <div role="alert" className="debug-notice">{runError}{activeRunId ? <button type="button" onClick={() => { setRunError(null); setStreamRevision(value => value + 1) }}>{text('modelCall.reconnect')}</button> : null}</div> : null}
        {selectedRun ? <ExperimentResult run={selectedRun} round={round} /> : <div className="debug-experiment-empty"><FlaskConical size={28} /><strong>{text('modelCall.experimentEmpty')}</strong><p>{text('modelCall.experimentEmptyHint')}</p></div>}
      </div>
      <p className="debug-experiment-footnote">{text('modelCall.runNotice')}</p>
    </ModelExperimentDialog> : null}
  </div>
}
