import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, BrainCircuit, Check, ChevronRight, Clock3, FileText, GitBranch, Layers3, Wrench } from 'lucide-react'
import { useI18n } from '../i18n'
import type { InspectorPanel } from './experiment-state'
import type { PresentationTraceCall, PresentationTraceRound } from './presentation-trace-data'
import './execution-tree.css'

type Artifact = 'outline' | 'brief' | 'sources'
export type TraceTreeFocus = { kind: 'stage'; stageId: string } | { kind: 'round'; roundId: string; panel: InspectorPanel }
interface ExecutionBranch {
  id: string
  title: string
  description: string
  code: string
  rounds: PresentationTraceRound[]
  children?: ExecutionBranch[]
  status?: 'complete' | 'waiting' | 'pending'
}
interface Props {
  rounds: PresentationTraceRound[]
  focusRequest: TraceTreeFocus | null
  onFocusHandled: () => void
  onPanelChange: (panel: InspectorPanel) => void
  onArtifact: (artifact: Artifact) => void
  onInspectRound: (roundId: string, panel?: InspectorPanel) => void
  onOpenTool?: (roundId: string, callId: string) => void
  onOpenRound?: (roundId: string) => void
}

function callTarget(call: PresentationTraceCall): string {
  for (const key of ['query', 'url', 'file_path', 'summary', 'stage', 'goal', 'prompt']) {
    const value = call.arguments[key]
    if (typeof value === 'string') return value
  }
  return ''
}

export function TraceExecutionTree({ rounds, focusRequest, onFocusHandled, onArtifact, onOpenTool, onOpenRound }: Props) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const treeId = useId()
  const nodeRefs = useRef(new Map<string, HTMLElement>())
  const branchRefs = useRef(new Map<string, HTMLButtonElement>())
  const [collapsedBranches, setCollapsedBranches] = useState<Set<string>>(() => new Set(['entry']))
  const [collapsedRounds, setCollapsedRounds] = useState<Set<string>>(() => new Set())
  const [focusedRound, setFocusedRound] = useState<string | null>(null)
  const [preparedFocus, setPreparedFocus] = useState<TraceTreeFocus | null>(null)
  const groups = useMemo<ExecutionBranch[]>(() => {
    const tr = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
    const entry = { id: 'entry', title: tr('流程入口', 'Workflow entry'), description: tr('从普通模式交接到 PPT Agent', 'Hand off from normal mode to the PPT Agent'), code: 'normal → presentation', rounds: rounds.filter(round => round.stage === 'main') }
    const planRounds = rounds.filter(round => round.stage === 'ppt_plan')
    return [entry,
      { id: 'ppt_brief', title: tr('明确需求', 'Define the brief'), description: tr('确认受众 → 写入与核对简报 → 交接规划', 'Confirm audience → write and check brief → hand off to planning'), code: 'ppt_brief', status: 'complete', rounds: rounds.filter(round => round.stage === 'ppt_brief') },
      { id: 'ppt_plan', title: tr('规划页面', 'Plan the slides'), description: tr('准备资料与逐页大纲，当前等待大纲确认。', 'Prepare sources and the slide outline; currently awaiting outline confirmation.'), code: 'ppt_plan', status: 'waiting', rounds: [], children: [
        { id: 'collect_evidence', title: tr('获取与整理资料', 'Gather and organize sources'), description: tr('搜索 → 直接访问 → 更换来源 → 提交资料报告', 'Search → direct fetch → try other sources → submit report'), code: 'collect_evidence', rounds: planRounds.filter(round => round.id !== 'R10') },
        { id: 'map_slides', title: tr('组织逐页大纲', 'Build the slide outline'), description: tr('提交页面结构，等待用户确认', 'Submit the slide structure and await confirmation'), code: 'map_slides', rounds: planRounds.filter(round => round.id === 'R10') },
      ] },
      { id: 'ppt_compose', title: tr('制作内容', 'Compose the presentation'), description: tr('大纲确认后进入，目前还没有页面制作记录。', 'Begins after outline confirmation; no slide composition has been recorded.'), code: 'ppt_compose', status: 'pending', rounds: [] },
      { id: 'ppt_review', title: tr('检查交付', 'Review the result'), description: tr('页面制作完成后进入，目前还没有检查或交付记录。', 'Begins after composition; no review or delivery has been recorded.'), code: 'ppt_review', status: 'pending', rounds: [] },
    ]
  }, [rounds, locale])

  useEffect(() => {
    if (!focusRequest) return
    function findPath(branches: ExecutionBranch[]): ExecutionBranch[] | null {
      for (const branch of branches) {
        const match = focusRequest?.kind === 'stage' ? branch.id === focusRequest.stageId : branch.rounds.some(round => round.id === focusRequest?.roundId)
        if (match) return [branch]
        const childPath = branch.children && findPath(branch.children)
        if (childPath) return [branch, ...childPath]
      }
      return null
    }
    const path = findPath(groups)
    if (!path) return
    const expanded = path.map(branch => branch.id)
    if (focusRequest.kind === 'stage') expanded.push(...(path.at(-1)?.children ?? []).map(branch => branch.id))
    setCollapsedBranches(previous => { const next = new Set(previous); expanded.forEach(id => next.delete(id)); return next })
    if (focusRequest.kind === 'round') {
      setCollapsedRounds(previous => { const next = new Set(previous); next.delete(focusRequest.roundId); return next })
      setFocusedRound(focusRequest.roundId)
    } else {
      const stage = path.at(-1)!
      const firstRound = stage.rounds[0] ?? stage.children?.[0]?.rounds[0]
      if (firstRound) setCollapsedRounds(previous => { const next = new Set(previous); next.delete(firstRound.id); return next })
      setFocusedRound(null)
    }
    setPreparedFocus(focusRequest)
  }, [focusRequest, groups])

  useEffect(() => {
    if (!focusRequest || preparedFocus !== focusRequest) return
    const frame = window.requestAnimationFrame(() => {
      const node = focusRequest.kind === 'stage' ? branchRefs.current.get(focusRequest.stageId) : nodeRefs.current.get(focusRequest.roundId)
      const container = node?.closest<HTMLElement>('.trace-review')
      if (!node || !container) return
      container.scrollTo({ top: container.scrollTop + node.getBoundingClientRect().top - container.getBoundingClientRect().top - 16, behavior: 'auto' })
      node.focus({ preventScroll: true })
      onFocusHandled()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusRequest, preparedFocus, onFocusHandled])

  function toggleBranch(id: string) {
    setCollapsedBranches(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function toggleRound(id: string) {
    setCollapsedRounds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function renderBranch(group: ExecutionBranch): JSX.Element {
    const expanded = !collapsedBranches.has(group.id)
    const count = group.rounds.length + (group.children ?? []).reduce((total, child) => total + child.rounds.length, 0)
    return <li key={group.id} className={`exec-branch${group.status ? ' exec-stage' : ''}`} data-stage-id={group.status ? group.id : undefined}>
        <button ref={node => { if (node) branchRefs.current.set(group.id, node); else branchRefs.current.delete(group.id) }} className="exec-branch-toggle" aria-expanded={expanded} aria-controls={`${treeId}-${group.id}`} onClick={() => toggleBranch(group.id)}><ChevronRight size={14} className="exec-chevron" /><Layers3 size={16} className="exec-branch-icon" /><span className="exec-branch-copy"><strong>{group.title}<code>{group.code}</code></strong><small>{group.description}</small></span><span className="exec-meta">{group.status && <span className={`exec-stage-status is-${group.status}`}>{group.status === 'complete' ? <Check size={12} /> : <Clock3 size={12} />}{group.status === 'complete' ? t('已完成', 'Complete') : group.status === 'waiting' ? t('等待确认', 'Awaiting confirmation') : t('尚未执行', 'Not started')}</span>}{count > 0 && <span>{count} {t('次响应', 'responses')}</span>}</span></button>
        <div className="exec-branch-body" id={`${treeId}-${group.id}`} hidden={!expanded}>
        {group.children && <ul className="exec-branches exec-subbranches">{group.children.map(renderBranch)}</ul>}
        {group.status === 'pending' && <p className="exec-pending-note">{t('等待上游阶段完成后，执行记录会出现在这里。', 'Execution records will appear here after the preceding stages finish.')}</p>}
        {group.rounds.length > 0 && <ul className="exec-rounds">
          {group.rounds.map(round => {
            const open = !collapsedRounds.has(round.id)
            const wait = round.id === 'R10'
            const artifact: Artifact | null = round.id === 'R10' ? 'outline' : round.id === 'R09' ? 'sources' : ['R03', 'R04'].includes(round.id) ? 'brief' : null
            return <li key={round.id} className={`exec-round${focusedRound === round.id ? ' is-focused' : ''}`}>
              <article className="exec-round-card" aria-label={round.title} tabIndex={-1} ref={node => { if (node) nodeRefs.current.set(round.id, node); else nodeRefs.current.delete(round.id) }}>
                <div className="exec-round-heading"><button className="exec-round-toggle" aria-expanded={open} aria-controls={`${treeId}-${round.id}-body`} onClick={() => toggleRound(round.id)}><ChevronRight size={13} className="exec-chevron" /><BrainCircuit size={15} /><strong>{round.title}</strong><code className="exec-round-id">{round.id}</code></button></div>
                <p className="exec-agent-summary">{round.summary}</p>
                <div className="exec-round-body" id={`${treeId}-${round.id}-body`} hidden={!open}>
                  <ul className="exec-calls" aria-label={t(`${round.title}的工具调用`, `Tool calls for ${round.title}`)}>{round.calls.map((call, callIndex) => <li key={call.id} className="exec-call">
                    <button className="exec-call-summary" data-round-id={round.id} data-call-id={call.id} disabled={!onOpenTool} onClick={() => onOpenTool?.(round.id, call.id)} aria-label={t(`查看工具调用 ${call.name} · ${round.id} · ${callIndex + 1}`, `Inspect tool call ${call.name} · ${round.id} · ${callIndex + 1}`)}>
                      <Wrench size={13} className="exec-tool-icon" /><code>{call.name}</code><span className="exec-call-target" title={callTarget(call)}>{callTarget(call)}</span><span className={`exec-call-status ${call.status === 'error' ? 'is-error' : 'is-success'}`}>{call.status === 'error' ? <AlertCircle size={12} /> : <Check size={12} />}{call.status === 'error' ? call.error?.startsWith('HTTP') ? call.error : t('失败', 'Failed') : t('成功', 'Succeeded')}</span><ChevronRight size={12} className="exec-chevron" />
                    </button>
                  </li>)}</ul>
                  <div className={`exec-outcome${wait ? ' is-waiting' : ''}`}>{wait ? <Clock3 size={14} /> : <GitBranch size={14} />}<p>{round.decision}</p></div>
                  {artifact && <button className="exec-artifact-link" onClick={() => onArtifact(artifact)}><FileText size={13} />{artifact === 'outline' ? t('预览大纲 · 4 章 / 11 页', 'Preview outline · 4 chapters / 11 slides') : artifact === 'brief' ? t('查看需求简报', 'Read the brief') : t('查看资料与引用', 'Inspect sources')}<ArrowRight size={12} /></button>}
                  <button className="exec-round-link" aria-label={t(`查看循环 ${round.id}`, `Inspect round ${round.id}`)} disabled={!onOpenRound} onClick={() => onOpenRound?.(round.id)}><BrainCircuit size={12} />{t('查看循环', 'Inspect round')}<code>{round.id}</code><ChevronRight size={12} /></button>
                </div>
              </article>
            </li>
          })}
        </ul>}
        </div>
      </li>
  }
  return <section className="exec-tree" aria-label={t('Agent 执行过程', 'Agent execution process')}>
    <header className="exec-tree-heading"><div><h2>{t('Agent 执行过程', 'Agent execution process')}</h2><p>{t('完整展示所有阶段。点击左侧阶段，跳转到对应的执行起点。', 'All stages in one tree. Use the sidebar to jump to a stage’s starting point.')}</p></div><div className="exec-tree-controls"><button onClick={() => { setCollapsedBranches(new Set()); setCollapsedRounds(new Set()) }}>{t('展开过程', 'Expand process')}</button><button onClick={() => setCollapsedBranches(new Set(groups.map(group => group.id)))}>{t('收起过程', 'Collapse process')}</button></div></header>
    <div className="exec-tree-root"><BrainCircuit size={19} /><strong>PPT Agent</strong><span>{t('完整流程 · 4 个阶段', 'Full workflow · 4 stages')}</span><code>presentation</code></div>
    <ul className="exec-branches">{groups.map(renderBranch)}</ul>
  </section>
}
