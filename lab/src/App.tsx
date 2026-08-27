import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import {
  Activity,
  AlertTriangle,
  Binary,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  Download,
  FileInput,
  GitBranch,
  Languages,
  Moon,
  PanelRight,
  RefreshCw,
  Search,
  Sun,
  TerminalSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import {
  isLabApiError,
  labApi,
  type JsonObject,
  type JsonValue,
  type OtaRound,
  type PromptReconstruction,
  type SessionSummary,
  type SourceHealth,
  type TurnDetail,
  type TurnSummary,
} from './api'
import { analyzePromptCachePotential, estimatePromptTokens } from './analytics'
import { resolveRoundCognitiveMode, type CognitiveModeDescriptor } from './cognitive-mode'
import {
  PromptCacheCompareModal,
  PromptReadableView,
  ResizablePane,
  SessionTreeList,
  TurnHistoryView,
  TurnPromptAnalysis,
  type TurnPromptPotentialRow,
} from './components'
import { I18nProvider, localeSelfName, useI18n, type Locale, type TranslationKey } from './i18n'
import {
  buildPromptViewModel,
  promptMessagesWithoutProviderMetadata,
  type CanonicalPromptBlockKind,
} from './prompt-view'
import {
  buildPromptCacheComparisonViewModel,
  comparePromptReconstructions,
} from './prompt-compare'
import type { LabModuleId, RoundTrace, RunStatus, SessionTrace } from './types'

type InspectorTab = 'overview' | 'prompt' | 'tools'
type Theme = 'dark' | 'light'

interface LabModule {
  id: LabModuleId
  labelKey: TranslationKey
  shortLabelKey: TranslationKey
  descriptionKey: TranslationKey
  icon: LucideIcon
}

const modules: LabModule[] = [
  {
    id: 'agent-loop',
    labelKey: 'module.agentLoop.label',
    shortLabelKey: 'module.agentLoop.short',
    descriptionKey: 'module.agentLoop.description',
    icon: Activity,
  },
  {
    id: 'file-import',
    labelKey: 'module.fileImport.label',
    shortLabelKey: 'module.fileImport.short',
    descriptionKey: 'module.fileImport.description',
    icon: FileInput,
  },
  {
    id: 'memory',
    labelKey: 'module.memory.label',
    shortLabelKey: 'module.memory.short',
    descriptionKey: 'module.memory.description',
    icon: BrainCircuit,
  },
]

const inspectorTabs: Array<{ id: InspectorTab; labelKey: TranslationKey; icon: LucideIcon }> = [
  { id: 'overview', labelKey: 'inspector.overview', icon: PanelRight },
  { id: 'prompt', labelKey: 'inspector.prompt', icon: Binary },
  { id: 'tools', labelKey: 'inspector.tools', icon: Wrench },
]

const statusKeys: Record<RunStatus, TranslationKey> = {
  completed: 'status.completed',
  running: 'status.running',
  attention: 'status.attention',
}

const phaseKeys: Record<RoundTrace['phases'][number]['kind'], TranslationKey> = {
  observe: 'phase.observe',
  think: 'phase.think',
  permission: 'phase.permission',
  act: 'phase.act',
  state: 'phase.state',
}

function firstItem<T>(items: readonly T[], label: string): T {
  const item = items[0]
  if (!item) throw new Error(`Bridgic Agent Lab requires at least one ${label}.`)
  return item
}

const defaultModule = firstItem(modules, 'module')

function defaultAnalysisPaneWidth(): number {
  if (typeof window === 'undefined') return 620
  return Math.round(Math.max(420, (window.innerWidth - 248) / 2))
}

function maxAnalysisPaneWidth(): number {
  if (typeof window === 'undefined') return 1200
  return Math.max(760, window.innerWidth - 248 - 420)
}

const promptBlockTitleKeys: Record<CanonicalPromptBlockKind, TranslationKey> = {
  persona: 'prompt.block.persona',
  context: 'prompt.block.context',
  session_history: 'prompt.block.sessionHistory',
  current_input: 'prompt.block.currentInput',
  current_turn: 'prompt.block.currentTurn',
  tools: 'prompt.block.tools',
}

const promptBlockDescriptionKeys: Record<CanonicalPromptBlockKind, TranslationKey> = {
  persona: 'prompt.block.personaDescription',
  context: 'prompt.block.contextDescription',
  session_history: 'prompt.block.sessionHistoryDescription',
  current_input: 'prompt.block.currentInputDescription',
  current_turn: 'prompt.block.currentTurnDescription',
  tools: 'prompt.block.toolsDescription',
}

function runStatus(status: string): RunStatus {
  const normalized = status.toLowerCase()
  if (['completed', 'complete', 'finish', 'finished', 'success'].includes(normalized)) return 'completed'
  if (['running', 'queued', 'awaiting', 'awaiting_human', 'awaiting_permission', 'awaiting_subagents'].includes(normalized)) {
    return 'running'
  }
  return 'attention'
}

function jsonText(value: JsonValue | JsonObject | null | undefined): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function rawString(raw: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function rawNumber(raw: JsonObject, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds == null || milliseconds <= 0) return '—'
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function previewText(value: string, fallback = '—'): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) return fallback
  return collapsed.length > 110 ? `${collapsed.slice(0, 107)}…` : collapsed
}

function persistedDate(value: string): Date {
  const stored = value.trim()
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(stored)
    ? `${stored.replace(' ', 'T')}Z`
    : stored
  return new Date(normalized)
}

function agentMode(detail: TurnDetail): string {
  const think = detail.agentState?.think
  if (think && typeof think === 'object' && !Array.isArray(think)) {
    const mode = typeof think.mode === 'string' ? think.mode : ''
    const stage = typeof think.stage === 'string' ? think.stage : ''
    const value = [mode, stage].filter(Boolean).join(' · ')
    if (value) return value
  }
  if (detail.session.parentSessionId) return `normal · child`
  return 'normal · main'
}

function actionDuration(round: OtaRound): number | null {
  return rawNumber(round.raw, 'act_duration_ms', 'actDurationMs')
}

function roundToTrace(round: OtaRound, detail: TurnDetail, index: number): RoundTrace {
  const tools = round.actionResult?.results ?? []
  const reasoning = rawString(round.raw, 'reasoning_content', 'reasoningContent')
  const observation = jsonText(round.observationResult)
  const stepContent = round.thinkResult?.stepContent ?? ''
  const resultSummary = tools.length > 0
    ? tools.map((tool) => `${tool.toolName}: ${tool.success ? 'success' : tool.error ?? 'error'}`).join(' · ')
    : ''
  const durationMs = actionDuration(round)
  const permission = round.permission
  const permissionDetail = permission?.verdicts.length
    ? permission.verdicts.map((item) => `${item.tool}: ${item.verdict}`).join(', ')
    : permission?.executionMode ?? detail.executionMode ?? '—'
  const isLastRound = index === detail.otaRecords.length - 1

  return {
    id: round.id,
    ordinal: round.ordinal,
    cognitiveMode: resolveRoundCognitiveMode(round, {
      agentState: detail.agentState,
      parentSessionId: detail.session.parentSessionId,
    }),
    summary: previewText(stepContent || resultSummary || observation),
    reasoning: reasoning || stepContent,
    observation,
    phases: [
      { kind: 'observe', label: 'Observe', detail: observation ? previewText(observation) : '—' },
      {
        kind: 'think',
        label: 'Think',
        detail: '',
        tone: 'accent',
      },
      {
        kind: 'permission',
        label: 'Permission',
        detail: permissionDetail,
        tone: permission?.verdicts.some((item) => item.verdict.toLowerCase().includes('deny')) ? 'warning' : undefined,
      },
      {
        kind: 'act',
        label: 'Act',
        detail: tools.length > 0 ? tools.map((tool) => tool.toolName).join(', ') : '—',
        tone: tools.length > 0 && tools.every((tool) => tool.success) ? 'success' : undefined,
      },
      {
        kind: 'state',
        label: 'State',
        detail: isLastRound ? detail.status : '—',
        tone: isLastRound && runStatus(detail.status) === 'completed' ? 'success' : undefined,
      },
    ],
    inputTokens: null,
    outputTokens: null,
    duration: formatDuration(durationMs),
    prompt: {
      fidelity: 'reconstructed',
      hash: '',
      components: [],
      messages: '',
    },
    tools: tools.map((tool) => {
      const verdict = permission?.verdicts.find((item) => item.id === tool.toolId || item.tool === tool.toolName)
      return {
        name: tool.toolName,
        status: tool.success ? 'success' : 'error',
        duration: '—',
        permission: verdict?.verdict ?? permission?.executionMode ?? detail.executionMode ?? '—',
        arguments: tool.toolArguments,
        result: tool.error ?? jsonText(tool.toolResult),
      }
    }),
    stateBefore: '',
    stateAfter: isLastRound ? jsonText(detail.agentState) : '',
    logs: [],
  }
}

function detailToTrace(detail: TurnDetail): SessionTrace {
  const lastRound = detail.otaRecords.at(-1)
  const persistedDuration = lastRound
    ? rawNumber(lastRound.raw, 'turn_duration_ms', 'turnDurationMs')
    : null
  return {
    id: detail.session.id,
    parentId: detail.session.parentSessionId ?? undefined,
    title: detail.session.title || detail.session.id,
    task: detail.userInput.text || detail.session.title || detail.id,
    status: runStatus(detail.status),
    mode: agentMode(detail),
    model: detail.model || detail.session.lastUsedModel || '—',
    duration: formatDuration(detail.durationMs || persistedDuration),
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    updatedAt: detail.createdAt,
    rounds: detail.otaRecords.map((round, index) => roundToTrace(round, detail, index)),
    turnId: detail.id,
    turnOrdinal: detail.sessionOrdinal + 1,
    executionMode: detail.executionMode,
    maxRounds: detail.maxRounds,
    finalAnswer: detail.finalAnswer,
    error: detail.error,
  }
}

function errorText(error: unknown): string {
  if (isLabApiError(error)) return error.message
  return error instanceof Error ? error.message : String(error)
}

async function loadAllSessions(signal: AbortSignal): Promise<SessionSummary[]> {
  const items: SessionSummary[] = []
  let cursor: string | undefined
  do {
    const page = await labApi.listSessions({ cursor, limit: 100 }, { signal })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

async function loadAllTurns(sessionId: string, signal: AbortSignal): Promise<TurnSummary[]> {
  const items: TurnSummary[] = []
  let cursor: string | undefined
  do {
    const page = await labApi.listSessionTurns(sessionId, { cursor, limit: 100 }, { signal })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

function statusIcon(status: RunStatus) {
  if (status === 'completed') return <Check size={11} aria-hidden="true" />
  if (status === 'attention') return <AlertTriangle size={11} aria-hidden="true" />
  return <CircleDot size={11} aria-hidden="true" />
}

function StatusPill({ status }: { status: RunStatus }) {
  const { t } = useI18n()
  return (
    <span className={`status-pill status-${status}`}>
      {statusIcon(status)}
      {t(statusKeys[status])}
    </span>
  )
}

function PlatformHeader({
  activeModule,
  onModuleChange,
  theme,
  onThemeChange,
}: {
  activeModule: LabModuleId
  onModuleChange: (module: LabModuleId) => void
  theme: Theme
  onThemeChange: () => void
}) {
  const { locale, t, toggleLocale } = useI18n()
  const targetLocale = locale === 'en-US' ? 'zh-CN' : 'en-US'
  const targetLocaleLabel = localeSelfName(targetLocale)
  const languageLabel = locale === 'en-US' ? t('language.switchToChinese') : t('language.switchToEnglish')

  return (
    <header className="platform-header">
      <div className="brand-lockup">
        <img src="/bridgic-icon.svg" alt="" className="brand-mark" />
        <div className="brand-copy">
          <strong>Bridgic Agent Lab</strong>
          <span>{t('brand.subtitle')}</span>
        </div>
      </div>

      <nav className="module-tabs" aria-label={t('nav.modules')}>
        {modules.map((module) => {
          const Icon = module.icon
          const active = module.id === activeModule
          return (
            <button
              key={module.id}
              type="button"
              className="module-tab"
              aria-current={active ? 'page' : undefined}
              onClick={() => onModuleChange(module.id)}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
              <span className="module-tab-full">{t(module.labelKey)}</span>
              <span className="module-tab-short">{t(module.shortLabelKey)}</span>
            </button>
          )
        })}
      </nav>

      <div className="header-actions">
        <span className="local-indicator"><span className="local-dot" />{t('data.local')}</span>
        <button
          type="button"
          className="language-button"
          aria-label={languageLabel}
          onClick={toggleLocale}
        >
          <Languages size={14} aria-hidden="true" />
          <span lang={targetLocale}>{targetLocaleLabel}</span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t(theme === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
          onClick={onThemeChange}
        >
          {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
        </button>
      </div>
    </header>
  )
}

function SessionSidebar({
  sessions,
  selectedSessionId,
  onSelectSession,
  health,
  loading,
  error,
  onRetry,
}: {
  sessions: SessionSummary[]
  selectedSessionId: string | null
  onSelectSession: (session: SessionSummary) => void
  health: SourceHealth | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  const [query, setQuery] = useState('')
  const { t } = useI18n()

  return (
    <div className="session-sidebar">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">{t('sidebar.traceSource')}</span>
          <h2>{t('sidebar.sessions')}</h2>
        </div>
        <span className="count-badge">{sessions.length}</span>
      </div>

      <label className="search-field">
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">{t('sidebar.search')}</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('sidebar.search')}
        />
      </label>

      <div className="source-line">
        <Database size={13} aria-hidden="true" />
        <span title={health?.path}>{t('sidebar.stateDatabase')}</span>
        <span className="read-only-label">{t('sidebar.readOnly')}</span>
      </div>

      <div className="session-list">
        {loading && (
          <div className="sidebar-empty">{t('sidebar.loading')}</div>
        )}
        {!loading && error && (
          <div className="sidebar-empty sidebar-error">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{t('sidebar.loadError')}</span>
            <code>{error}</code>
            <button type="button" className="secondary-button" onClick={onRetry}>
              <RefreshCw size={12} aria-hidden="true" />{t('action.retry')}
            </button>
          </div>
        )}
        {!loading && !error && (
          <SessionTreeList
            sessions={sessions}
            query={query}
            defaultExpanded={false}
            selectedSessionId={selectedSessionId}
            onSelectSession={onSelectSession}
            labels={{
              tree: t('sidebar.sessions'),
              untitled: t('sidebar.sessions'),
              expand: t('sidebar.expandSubagents'),
              collapse: t('sidebar.collapseSubagents'),
              noResults: query
                ? t('sidebar.emptySearch', { query })
                : t('sidebar.emptyDatabase'),
            }}
          />
        )}
      </div>
    </div>
  )
}

function RunSummary({
  session,
  estimatedInputTokens,
}: {
  session: SessionTrace
  estimatedInputTokens: number | null
}) {
  const { formatNumber, t } = useI18n()
  const roundCountKey = session.rounds.length === 1 ? 'run.roundCountOne' : 'run.roundCountMany'

  return (
    <div className="run-summary">
      <div className="run-breadcrumb">
        {t('data.local')} / {t('sidebar.sessions')} / {session.title} / {t('breadcrumb.turn', { ordinal: session.turnOrdinal ?? 1 })}
      </div>
      <div className="run-title-row">
        <div>
          <div className="run-title-with-status">
            <h1 title={session.task}>{session.task}</h1>
            <StatusPill status={session.status} />
          </div>
          <div className="run-tags">
            <code>{session.mode}</code>
            <code>{session.model}</code>
            {session.executionMode && <code>{session.executionMode}</code>}
            <span>{t(roundCountKey, { count: session.rounds.length })}</span>
            <span><Clock3 size={12} aria-hidden="true" />{session.duration}</span>
          </div>
        </div>
        <div className="run-summary-actions">
          <div className="run-token-summary" aria-label={t('tokens.usage')}>
            <span><small>{t('tokens.inputActual')}</small>{formatNumber(session.inputTokens)}</span>
            <span>
              <small>{t('tokens.inputEstimated')}</small>
              {estimatedInputTokens === null ? '—' : `≈ ${formatNumber(estimatedInputTokens)}`}
            </span>
            <span><small>{t('tokens.outputActual')}</small>{formatNumber(session.outputTokens)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function TurnRail({
  turns,
  selectedTurnId,
  onSelectTurn,
}: {
  turns: TurnSummary[]
  selectedTurnId: string
  onSelectTurn: (turnId: string) => void
}) {
  const { formatNumber, t } = useI18n()
  const chronological = [...turns].sort((left, right) =>
    left.sessionOrdinal - right.sessionOrdinal || left.id.localeCompare(right.id))

  return (
    <div className="turn-rail-shell">
      <span className="turn-rail-label">{t('run.turns')}</span>
      <div className="turn-rail" aria-label={t('run.turns')}>
        {chronological.map((turn) => {
          const selected = turn.id === selectedTurnId
          const status = runStatus(turn.status)
          return (
            <button
              type="button"
              className="turn-rail-item"
              aria-current={selected ? 'true' : undefined}
              aria-label={t('run.selectTurn', { ordinal: turn.sessionOrdinal + 1 })}
              onClick={() => onSelectTurn(turn.id)}
              key={turn.id}
            >
              <span className={`session-status-dot status-dot-${status}`} aria-hidden="true" />
              <span>
                <strong>T{turn.sessionOrdinal + 1}</strong>
                <small>{previewText(turn.userInput.text)}</small>
              </span>
              <code>{formatNumber(turn.inputTokens + turn.outputTokens)}</code>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function cognitiveModeLabel(mode: CognitiveModeDescriptor, t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  if (mode.mode === 'build') return t('thinking.buildMode', { stage: mode.stage })
  if (mode.mode === 'run_workflow') {
    return t(mode.stage === 'validate' ? 'thinking.workflowValidate' : 'thinking.workflowExecute')
  }
  return t(mode.stage === 'child' ? 'thinking.childAgent' : 'thinking.generalAgent')
}

function RoundCard({
  round,
  selected,
  onSelect,
}: {
  round: RoundTrace
  selected: boolean
  onSelect: () => void
}) {
  const { formatNumber, t } = useI18n()
  const hasRoundUsage = round.inputTokens != null && round.outputTokens != null

  return (
    <button
      type="button"
      className="round-card"
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="round-number">{t('round.label', { ordinal: round.ordinal })}</span>
      <span className="round-content">
        <span className="phase-strip">
          {round.phases.map((phase) => (
            <span key={phase.kind} className={`phase-cell phase-${phase.kind}${phase.tone ? ` phase-${phase.tone}` : ''}`}>
              <strong>{t(phaseKeys[phase.kind])}</strong>
              <small>{phase.kind === 'think' ? cognitiveModeLabel(round.cognitiveMode, t) : phase.detail}</small>
            </span>
          ))}
        </span>
        <span className="round-footer">
          <span>{round.summary}</span>
          <span className="round-metrics">
            {hasRoundUsage
              ? t('round.metrics', {
                input: formatNumber(round.inputTokens ?? 0),
                output: formatNumber(round.outputTokens ?? 0),
                duration: round.duration,
              })
              : t('round.actionDuration', { duration: round.duration })}
          </span>
        </span>
      </span>
    </button>
  )
}

function TraceWorkspace({
  session,
  turns,
  selectedTurnId,
  onSelectTurn,
  selectedRoundId,
  onSelectRound,
  prompt,
  promptLoading,
  promptError,
  estimatedInputTokens,
  activeDetailTab,
  onDetailTabChange,
}: {
  session: SessionTrace
  turns: TurnSummary[]
  selectedTurnId: string
  onSelectTurn: (turnId: string) => void
  selectedRoundId: string | null
  onSelectRound: (round: RoundTrace) => void
  prompt: PromptReconstruction | null
  promptLoading: boolean
  promptError: string | null
  estimatedInputTokens: number | null
  activeDetailTab: InspectorTab
  onDetailTabChange: (tab: InspectorTab) => void
}) {
  const { t } = useI18n()
  return (
    <main className="trace-workspace">
      <RunSummary session={session} estimatedInputTokens={estimatedInputTokens} />
      <TurnRail turns={turns} selectedTurnId={selectedTurnId} onSelectTurn={onSelectTurn} />
      <div className="trace-scroll-area">
        <div className="stage-divider">
          <span>{session.mode}</span>
          <span className="stage-rule" />
        </div>
        <div className="round-list">
          {session.rounds.map((round) => {
            const selected = round.id === selectedRoundId
            return (
              <div className="round-stack" key={round.id}>
                <RoundCard
                  round={round}
                  selected={selected}
                  onSelect={() => onSelectRound(round)}
                />
                {selected && (
                  <RoundDetail
                    round={round}
                    prompt={prompt}
                    promptLoading={promptLoading}
                    promptError={promptError}
                    activeTab={activeDetailTab}
                    onTabChange={onDetailTabChange}
                    onCollapse={() => onSelectRound(round)}
                  />
                )}
              </div>
            )
          })}
          {session.rounds.length === 0 && (
            <div className="workspace-empty">{t('run.noRounds')}</div>
          )}
        </div>
      </div>
    </main>
  )
}

function OverviewPanel({ round }: { round: RoundTrace }) {
  const { formatNumber, t } = useI18n()
  return (
    <div className="inspector-section-stack">
      <section className="inspector-section">
        <span className="section-label">{t('overview.observation')}</span>
        <p>{round.observation || '—'}</p>
      </section>
      <section className="inspector-section">
        <span className="section-label">{t('overview.reasoning')}</span>
        <p>{round.reasoning || '—'}</p>
      </section>
      <section className="inspector-section">
        <span className="section-label">{t('overview.roundResult')}</span>
        <p>{round.summary || '—'}</p>
      </section>
      <dl className="detail-list">
        <div><dt>{t('overview.duration')}</dt><dd>{round.duration}</dd></div>
        <div><dt>{t('overview.inputTokens')}</dt><dd>{round.inputTokens == null ? '—' : formatNumber(round.inputTokens)}</dd></div>
        <div><dt>{t('overview.outputTokens')}</dt><dd>{round.outputTokens == null ? '—' : formatNumber(round.outputTokens)}</dd></div>
        <div><dt>{t('overview.toolCalls')}</dt><dd>{round.tools.length}</dd></div>
      </dl>
    </div>
  )
}

function metadataNumber(metadata: JsonObject | undefined, key: string): number {
  const value = metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

interface CompactionPromptBlock {
  kind?: string
  metadata?: JsonObject
}

function hasCompactionNotice(block: CompactionPromptBlock): boolean {
  return block.metadata?.compactionApplied === true || block.metadata?.finalCompactionDeferred === true
}

function PromptCompactionNotice({ block }: { block: CompactionPromptBlock }) {
  const { formatNumber, t } = useI18n()
  const metadata = block.metadata
  const applied = metadata?.compactionApplied === true
  const deferred = metadata?.finalCompactionDeferred === true
  if (!applied && !deferred) return null

  const notices: Array<{ key: string; title: string; detail: string; tone: 'info' | 'warning' }> = []
  if (applied && block.kind === 'session_history') {
    const boundary = metadataNumber(metadata, 'compactedThroughOrdinal') + 1
    notices.push({
      key: 'session-applied',
      title: t('prompt.compaction.sessionTitle'),
      detail: t('prompt.compaction.sessionDetail', {
        compacted: formatNumber(metadataNumber(metadata, 'compactedTurns')),
        through: formatNumber(boundary),
        replayed: formatNumber(metadataNumber(metadata, 'includedTurns')),
        available: formatNumber(metadataNumber(metadata, 'availableTurns')),
      }),
      tone: 'info',
    })
  }
  if (applied && block.kind === 'current_turn') {
    notices.push({
      key: 'turn-applied',
      title: t('prompt.compaction.turnTitle'),
      detail: t('prompt.compaction.turnDetail', {
        compacted: formatNumber(metadataNumber(metadata, 'compactedRounds')),
        replayed: formatNumber(metadataNumber(metadata, 'replayedRounds')),
        available: formatNumber(metadataNumber(metadata, 'completedRounds')),
      }),
      tone: 'info',
    })
  }
  if (deferred) {
    notices.push({
      key: 'deferred',
      title: t('prompt.compaction.deferredTitle'),
      detail: t('prompt.compaction.deferredDetail'),
      tone: 'warning',
    })
  }

  return (
    <div className="prompt-compaction-notices">
      {notices.map((notice) => (
        <div key={notice.key} className={`prompt-compaction-notice is-${notice.tone}`}>
          <BrainCircuit size={15} aria-hidden="true" />
          <span>
            <strong>{notice.title}</strong>
            <small>{notice.detail}</small>
          </span>
        </div>
      ))}
    </div>
  )
}

function PromptPanel({
  prompt,
  loading,
  error,
}: {
  prompt: PromptReconstruction | null
  loading: boolean
  error: string | null
}) {
  const { formatNumber, t } = useI18n()
  const [showNativeMessages, setShowNativeMessages] = useState(false)

  useEffect(() => {
    if (!showNativeMessages) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setShowNativeMessages(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [showNativeMessages])

  if (loading) {
    return <InspectorNotice icon={GitBranch} title={t('prompt.rebuilding')} detail={t('prompt.rebuildingDescription')} />
  }
  if (error) {
    return <InspectorNotice icon={AlertTriangle} title={t('prompt.rebuildError')} detail={error} />
  }
  if (!prompt) {
    return <InspectorNotice icon={GitBranch} title={t('prompt.unavailable')} detail={t('prompt.unavailableDescription')} />
  }

  const view = buildPromptViewModel(prompt, {
    blockTitles: Object.fromEntries(
      Object.entries(promptBlockTitleKeys).map(([kind, key]) => [kind, t(key)]),
    ),
    documentTitle: t('prompt.completeRequest'),
    emptyBlockText: t('prompt.emptyContent'),
  })
  const readableBlocks = view.blocks.map((block) => ({
    ...block,
    description: t(promptBlockDescriptionKeys[block.kind]),
    badges: [
      ...(block.metadata?.compactionApplied === true
        ? [{ label: t('prompt.compaction.appliedBadge'), tone: 'info' as const }]
        : []),
      ...(block.metadata?.finalCompactionDeferred === true
        ? [{ label: t('prompt.compaction.deferredBadge'), tone: 'warning' as const }]
        : []),
    ],
  }))
  const messageBlocks = readableBlocks.filter((block) => block.kind !== 'tools')
  const toolSurfaceBlock = readableBlocks.find((block) => block.kind === 'tools') ?? null
  const roleLabels = {
    system: t('prompt.role.system'),
    developer: t('prompt.role.developer'),
    user: t('prompt.role.user'),
    assistant: t('prompt.role.assistant'),
    tool: t('prompt.role.tool'),
  }
  const readableMessages = view.transcript.messages.map((message) => ({
    ...message,
    label: t('prompt.messageLabel', {
      role: message.role in roleLabels
        ? roleLabels[message.role as keyof typeof roleLabels]
        : message.role,
      index: message.index + 1,
    }),
  }))
  const promptReadableLabels = {
    blocks: t('prompt.blocks'),
    messages: t('prompt.nativeMessages'),
    copy: t('prompt.copy'),
    copied: t('prompt.copied'),
    emptyContent: t('prompt.emptyContent'),
    noItems: t('prompt.none'),
    sources: t('prompt.sources'),
    toolCalls: t('prompt.toolCalls'),
    arguments: t('prompt.arguments'),
    roles: roleLabels,
  }
  const turnHistoryBlock = messageBlocks.find((block) => block.kind === 'current_turn')
  const componentTokenEstimates = messageBlocks.map((block) => estimatePromptTokens(block.text))
  const totalEstimatedTokens = componentTokenEstimates.reduce((total, tokens) => total + tokens, 0)
  const componentPercents = componentTokenEstimates.map((tokens) => (
    totalEstimatedTokens > 0 ? tokens / totalEstimatedTokens * 100 : 0
  ))
  const percentLabel = (value: number) => value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`
  const copyPromptText = typeof navigator !== 'undefined' && navigator.clipboard?.writeText
    ? (text: string) => navigator.clipboard.writeText(text)
    : undefined
  const expandedBlockIds: string[] = []
  const exportRawRequest = () => {
    const rawRequest = JSON.stringify({
      model: prompt.model,
      messages: promptMessagesWithoutProviderMetadata(prompt.messages),
      tools: prompt.tools,
    }, null, 2)
    const blob = new Blob([rawRequest], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const safeTurnId = prompt.turnId.replace(/[^a-zA-Z0-9_-]/g, '_')
    anchor.href = url
    anchor.download = `bridgic-agent-request-${safeTurnId}-round-${prompt.roundIndex + 1}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div className="inspector-section-stack prompt-inspector-stack">
      <section className="inspector-section">
        <div className="section-label-row">
          <span className="section-label">{t('prompt.messageComposition')}</span>
          <span className="composition-size-note">{t('prompt.tokenEstimateMeasure')}</span>
        </div>
        <div className="composition-bar" aria-label={t('prompt.componentProportions')}>
          {messageBlocks.map((block, index) => (
            <span
              key={block.id}
              className={`composition-segment composition-${index + 1}`}
              style={{ width: `${componentPercents[index] ?? 0}%` }}
            />
          ))}
        </div>
        <div className="composition-legend">
          {messageBlocks.map((block, index) => (
            <span key={block.id} title={block.label}>
              <i className={`legend-dot composition-${index + 1}`} />
              <b>{block.label}</b>
              {percentLabel(componentPercents[index] ?? 0)}
              <code>≈ {formatNumber(componentTokenEstimates[index] ?? 0)}</code>
            </span>
          ))}
        </div>
      </section>
      <PromptReadableView
        blocks={messageBlocks}
        messages={[]}
        showFidelity={false}
        showLimitations={false}
        defaultExpandedBlockIds={expandedBlockIds}
        labels={{ ...promptReadableLabels, blocks: t('prompt.messageBlocks') }}
        renderBlockContent={(block) => {
          if (block.id === turnHistoryBlock?.id) {
            return (
              <div className="prompt-history-block-content">
                <PromptCompactionNotice block={block} />
                <TurnHistoryView
                  messages={prompt.messages}
                  messageIndexes={turnHistoryBlock.messageIndexes}
                  labels={{
                    title: t('prompt.turnHistory.title'),
                    step: t('prompt.turnHistory.step'),
                    assistant: t('prompt.turnHistory.assistant'),
                    assistantDecision: t('prompt.turnHistory.assistantDecision'),
                    toolCalls: t('prompt.turnHistory.toolCalls'),
                    toolCall: t('prompt.turnHistory.toolCall'),
                    arguments: t('prompt.turnHistory.arguments'),
                    noArguments: t('prompt.turnHistory.noArguments'),
                    toolResult: t('prompt.turnHistory.toolResult'),
                    noToolResult: t('prompt.turnHistory.noToolResult'),
                    unmatchedToolResult: t('prompt.turnHistory.unmatchedToolResult'),
                    observations: t('prompt.turnHistory.observations'),
                    observation: t('prompt.turnHistory.observation'),
                    noObservation: t('prompt.turnHistory.noObservation'),
                    callId: t('prompt.turnHistory.callId'),
                    message: t('prompt.turnHistory.message'),
                    empty: t('prompt.turnHistory.empty'),
                  }}
                />
              </div>
            )
          }
          if (block.kind === 'session_history' && hasCompactionNotice(block)) {
            return (
              <div className="prompt-history-block-content">
                <PromptCompactionNotice block={block} />
                <pre className="prompt-history-transcript">{block.text}</pre>
              </div>
            )
          }
          return undefined
        }}
        copyText={copyPromptText}
      />
      {toolSurfaceBlock && (
        <PromptReadableView
          className="prompt-parallel-tool-view"
          blocks={[toolSurfaceBlock]}
          messages={[]}
          showFidelity={false}
          showLimitations={false}
          defaultExpandedBlockIds={expandedBlockIds}
          labels={{ ...promptReadableLabels, blocks: t('prompt.block.tools') }}
          copyText={copyPromptText}
        />
      )}
      <button
        type="button"
        className="prompt-native-message-trigger"
        onClick={() => setShowNativeMessages(true)}
      >
        <Binary size={13} aria-hidden="true" />
        <span>{t('prompt.viewNativeMessages')}</span>
        <small>{t('prompt.requestItemCount', { messages: readableMessages.length, tools: prompt.tools.length })}</small>
        <ChevronRight size={13} aria-hidden="true" />
      </button>
      {showNativeMessages && (
        <div
          className="prompt-message-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowNativeMessages(false)
          }}
        >
          <section
            className="prompt-message-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prompt-message-dialog-title"
          >
            <header>
              <div className="prompt-message-dialog-title">
                <strong id="prompt-message-dialog-title">{t('prompt.nativeMessages')}</strong>
                <span>{t('prompt.nativeMessagesDescription')}</span>
              </div>
              <div className="prompt-message-dialog-actions">
                <button type="button" className="is-export" onClick={exportRawRequest}>
                  <Download size={12} aria-hidden="true" />
                  {t('prompt.exportRawRequest')}
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={() => setShowNativeMessages(false)}
                  aria-label={t('prompt.closeNativeMessages')}
                >
                  {t('prompt.close')}
                </button>
              </div>
            </header>
            <div className="prompt-message-dialog-body prompt-message-dialog-request-grid">
              <PromptReadableView
                blocks={[]}
                messages={readableMessages}
                showFidelity={false}
                showLimitations={false}
                labels={{ ...promptReadableLabels, messages: t('prompt.messageSequence') }}
                copyText={copyPromptText}
              />
              {toolSurfaceBlock && (
                <PromptReadableView
                  blocks={[toolSurfaceBlock]}
                  messages={[]}
                  showFidelity={false}
                  showLimitations={false}
                  defaultExpandedBlockIds={expandedBlockIds}
                  labels={{ ...promptReadableLabels, blocks: t('prompt.block.tools') }}
                  copyText={copyPromptText}
                />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function InspectorNotice({
  icon: Icon,
  title,
  detail,
}: {
  icon: LucideIcon
  title: string
  detail: string
}) {
  return (
    <div className="inspector-empty">
      <Icon size={22} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  )
}

function ToolsPanel({ round }: { round: RoundTrace }) {
  const { t } = useI18n()
  if (round.tools.length === 0) {
    return (
      <div className="inspector-empty">
        <TerminalSquare size={22} aria-hidden="true" />
        <strong>{t('tools.noCalls')}</strong>
        <span>{t('tools.noCallsDescription')}</span>
      </div>
    )
  }

  return (
    <div className="tool-stack">
      {round.tools.map((tool) => (
        <section className="tool-card" key={`${tool.name}-${JSON.stringify(tool.arguments)}`}>
          <div className="tool-card-heading">
            <span><Wrench size={13} aria-hidden="true" /><strong>{tool.name}</strong></span>
            <span className={`tool-result tool-result-${tool.status}`}>
              {t(tool.status === 'success' ? 'tools.status.success' : 'tools.status.error')} · {tool.duration}
            </span>
          </div>
          <dl className="detail-list compact">
            <div><dt>{t('tools.permission')}</dt><dd>{tool.permission}</dd></div>
          </dl>
          <span className="section-label">{t('tools.arguments')}</span>
          <pre className="code-block">{JSON.stringify(tool.arguments, null, 2)}</pre>
          <span className="section-label">{t('tools.result')}</span>
          <p className="tool-output">{tool.result}</p>
        </section>
      ))}
    </div>
  )
}

function moveInspectorTab(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  onTabChange: (tab: InspectorTab) => void,
) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return

  event.preventDefault()
  let nextIndex = index
  if (event.key === 'ArrowLeft') nextIndex = (index - 1 + inspectorTabs.length) % inspectorTabs.length
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % inspectorTabs.length
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = inspectorTabs.length - 1

  const nextTab = inspectorTabs[nextIndex]
  if (!nextTab) return
  onTabChange(nextTab.id)
  event.currentTarget.parentElement
    ?.querySelector<HTMLButtonElement>(`#inspector-tab-${nextTab.id}`)
    ?.focus()
}

function RoundDetail({
  round,
  prompt,
  promptLoading,
  promptError,
  activeTab,
  onTabChange,
  onCollapse,
}: {
  round: RoundTrace
  prompt: PromptReconstruction | null
  promptLoading: boolean
  promptError: string | null
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  onCollapse: () => void
}) {
  const { t } = useI18n()
  return (
    <section className="round-detail-panel">
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">{t('detail.selectedNode')}</span>
          <h2>{t('round.label', { ordinal: round.ordinal })}</h2>
        </div>
        <div className="round-detail-actions">
          <button type="button" className="round-detail-close" aria-label={t('detail.collapse')} onClick={onCollapse}>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="inspector-tabs" role="tablist" aria-label={t('detail.ariaLabel')}>
        {inspectorTabs.map((tab, index) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              id={`inspector-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls="inspector-tabpanel"
              tabIndex={activeTab === tab.id ? 0 : -1}
              className="inspector-tab"
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(event) => moveInspectorTab(event, index, onTabChange)}
            >
              <Icon size={13} aria-hidden="true" />
              {t(tab.labelKey)}
            </button>
          )
        })}
      </div>

      <div
        id="inspector-tabpanel"
        className="inspector-content"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${activeTab}`}
      >
        {activeTab === 'overview' && <OverviewPanel round={round} />}
        {activeTab === 'prompt' && (
          <PromptPanel prompt={prompt} loading={promptLoading} error={promptError} />
        )}
        {activeTab === 'tools' && <ToolsPanel round={round} />}
      </div>
    </section>
  )
}

export function PromptCacheAnalysisSection({
  rows,
  selected,
  selectedTurnId,
  loading,
  error,
  expanded,
  onToggle,
  onSelectTurn,
  onCompareRound,
}: {
  rows: readonly TurnPromptPotentialRow[]
  selected: TurnPromptPotentialRow | null
  selectedTurnId: string | null
  loading: boolean
  error: string | null
  expanded: boolean
  onToggle: () => void
  onSelectTurn: (turnId: string) => void
  onCompareRound: (roundId: string) => void
}) {
  const { formatNumber, t } = useI18n()
  const hasComparableRequests = (selected?.comparableRounds ?? 0) > 0

  return (
    <section className={`analysis-section analysis-section-card analysis-section-cache${expanded ? ' is-expanded' : ' is-collapsed'}`}>
      <button
        type="button"
        className="analysis-section-title analysis-section-toggle"
        aria-expanded={expanded}
        aria-controls="prompt-cache-analysis-details"
        aria-label={t(expanded ? 'analysis.collapseCacheAnalysis' : 'analysis.expandCacheAnalysis')}
        onClick={onToggle}
      >
        <span><Database size={14} aria-hidden="true" />{t('analysis.cachePotential')}</span>
        <span className="analysis-section-toggle-action">
          <span>{t(expanded ? 'analysis.collapseSection' : 'analysis.expandSection')}</span>
          <ChevronRight className="analysis-section-toggle-chevron" size={14} aria-hidden="true" />
        </span>
      </button>

      {selected && (
        <div className="cache-diagnosis">
          {hasComparableRequests ? (
            <>
              <div className="cache-diagnosis-grid">
                <div className="analysis-kpi analysis-kpi-potential">
                  <small>{t('analysis.cacheHitTokens')}</small>
                  <strong>{selected.reusableTokens === null
                    ? '—'
                    : `≈ ${formatNumber(selected.reusableTokens)}`}</strong>
                  <span>{selected.potentialRate === null
                    ? t('analysis.cachePotentialComputing')
                    : t('analysis.ofEstimatedPromptTokens', { percentage: `${Math.round(selected.potentialRate * 100)}%` })}</span>
                </div>
                <div className="analysis-kpi cache-miss-kpi">
                  <small>{t('analysis.cacheMissTokens')}</small>
                  <strong>{selected.nonReusableTokens === null
                    ? '—'
                    : `≈ ${formatNumber(selected.nonReusableTokens)}`}</strong>
                  <span>{selected.nonReusableRate === null
                    ? t('analysis.cachePotentialComputing')
                    : t('analysis.ofEstimatedPromptTokens', { percentage: `${Math.round(selected.nonReusableRate * 100)}%` })}</span>
                </div>
              </div>
              {selected.potentialRate !== null && (
                <div className="cache-expected-split" aria-label={t('analysis.expectedCacheSplit')}>
                  <span style={{ width: `${Math.max(0, Math.min(1, selected.potentialRate)) * 100}%` }} />
                  <i style={{ width: `${Math.max(0, Math.min(1, 1 - selected.potentialRate)) * 100}%` }} />
                </div>
              )}
            </>
          ) : (
            <div className="cache-no-baseline">
              <strong>{selected.totalRounds === 0
                ? t('analysis.cachePotentialEmpty')
                : t('analysis.noComparableTitle')}</strong>
            </div>
          )}
        </div>
      )}

      <div
        id="prompt-cache-analysis-details"
        className="analysis-section-cache-content"
        hidden={!expanded}
      >
        {expanded && (
          <TurnPromptAnalysis
            rows={rows}
            selectedTurnId={selectedTurnId}
            loading={loading}
            error={error}
            onSelectTurn={onSelectTurn}
            onCompareRound={onCompareRound}
          />
        )}
      </div>
    </section>
  )
}

export function AnalysisPanel({
  rows,
  selectedTurnId,
  loading,
  error,
  onSelectTurn,
  onCompareRound,
}: {
  rows: readonly TurnPromptPotentialRow[]
  selectedTurnId: string | null
  loading: boolean
  error: string | null
  onSelectTurn: (turnId: string) => void
  onCompareRound: (roundId: string) => void
}) {
  const { formatNumber, t } = useI18n()
  const [cacheExpanded, setCacheExpanded] = useState(false)
  const selected = rows.find((row) => row.turnId === selectedTurnId) ?? null

  if (!selected && !loading) {
    return (
      <section className="analysis-panel analysis-placeholder">
        <InspectorNotice icon={Activity} title={t('analysis.title')} detail={t('analysis.noTurn')} />
      </section>
    )
  }

  const currentTotal = selected ? selected.inputTokens + selected.outputTokens : 0
  const inputShare = selected && currentTotal > 0 ? selected.inputTokens / currentTotal * 100 : 0
  const outputShare = selected && currentTotal > 0 ? selected.outputTokens / currentTotal * 100 : 0
  return (
    <section className="analysis-panel">
      <header className="analysis-heading">
        <div>
          <span className="eyebrow">{t('analysis.scope')}</span>
          <h2>{t('analysis.title')}</h2>
        </div>
        {selected && (
          <span className="analysis-turn-badge">{t('breadcrumb.turn', { ordinal: selected.ordinal + 1 })}</span>
        )}
      </header>

      <div className="analysis-scroll">
        {selected && (
          <section className="analysis-section analysis-section-card analysis-section-tokens">
            <div className="analysis-section-title">
              <span><Binary size={14} aria-hidden="true" />{t('analysis.tokens')}</span>
              <span className="metric-availability is-available">{t('analysis.actualAndEstimated')}</span>
            </div>
            <div className="analysis-kpi-grid analysis-kpi-grid-three">
              <div className="analysis-kpi analysis-kpi-primary">
                <small>{t('tokens.inputActual')}</small>
                <strong>{formatNumber(selected.inputTokens)}</strong>
                <span>{t('analysis.persisted')}</span>
              </div>
              <div className="analysis-kpi">
                <small>{t('tokens.inputEstimated')}</small>
                <strong>{selected.estimatedInputTokens === null ? '—' : `≈ ${formatNumber(selected.estimatedInputTokens)}`}</strong>
                <span>{t('analysis.reconstructedEstimate')}</span>
              </div>
              <div className="analysis-kpi">
                <small>{t('tokens.outputActual')}</small>
                <strong>{formatNumber(selected.outputTokens)}</strong>
                <span>{t('analysis.persisted')}</span>
              </div>
            </div>
            <div className="token-composition" aria-label={t('tokens.usage')}>
              <span className="token-input-segment" style={{ width: `${inputShare}%` }} />
              <span className="token-output-segment" style={{ width: `${outputShare}%` }} />
            </div>
          </section>
        )}

        <PromptCacheAnalysisSection
          rows={rows}
          selected={selected}
          selectedTurnId={selectedTurnId}
          loading={loading}
          error={error}
          expanded={cacheExpanded}
          onToggle={() => setCacheExpanded((current) => !current)}
          onSelectTurn={onSelectTurn}
          onCompareRound={onCompareRound}
        />
      </div>
    </section>
  )
}

function AgentLoopLab() {
  const { formatNumber, t } = useI18n()
  const [health, setHealth] = useState<SourceHealth | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [turnsLoading, setTurnsLoading] = useState(false)
  const [turnsError, setTurnsError] = useState<string | null>(null)
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TurnDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<PromptReconstruction | null>(null)
  const [promptLoading, setPromptLoading] = useState(false)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [sessionPrompts, setSessionPrompts] = useState<PromptReconstruction[]>([])
  const [sessionPromptsLoading, setSessionPromptsLoading] = useState(false)
  const [sessionPromptsError, setSessionPromptsError] = useState<string | null>(null)
  const [promptComparisonRoundId, setPromptComparisonRoundId] = useState<string | null>(null)
  const [activeInspectorTab, setActiveInspectorTab] = useState<InspectorTab>('overview')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setSessionsLoading(true)
    setSessionsError(null)
    Promise.all([
      labApi.getSourceHealth({ signal: controller.signal }),
      loadAllSessions(controller.signal),
    ]).then(([nextHealth, items]) => {
      setHealth(nextHealth)
      setSessions(items)
      setSelectedSessionId((current) =>
        current && items.some((session) => session.id === current)
          ? current
          : items[0]?.id ?? null)
    }).catch((error: unknown) => {
      if (isLabApiError(error) && error.kind === 'aborted') return
      setSessionsError(errorText(error))
      setSessions([])
      setSelectedSessionId(null)
    }).finally(() => {
      if (!controller.signal.aborted) setSessionsLoading(false)
    })
    return () => controller.abort()
  }, [reloadKey])

  useEffect(() => {
    if (!selectedSessionId) {
      setTurns([])
      setSelectedTurnId(null)
      setSessionPrompts([])
      setSessionPromptsError(null)
      return
    }
    const controller = new AbortController()
    setTurnsLoading(true)
    setTurnsError(null)
    setDetail(null)
    setSelectedRoundId(null)
    loadAllTurns(selectedSessionId, controller.signal)
      .then((items) => {
        setTurns(items)
        setSelectedTurnId((current) =>
          current && items.some((turn) => turn.id === current)
            ? current
            : items[0]?.id ?? null)
      })
      .catch((error: unknown) => {
        if (isLabApiError(error) && error.kind === 'aborted') return
        setTurnsError(errorText(error))
        setTurns([])
        setSelectedTurnId(null)
      })
      .finally(() => {
        if (!controller.signal.aborted) setTurnsLoading(false)
      })
    return () => controller.abort()
  }, [selectedSessionId])

  useEffect(() => {
    if (!selectedSessionId) {
      setSessionPrompts([])
      setSessionPromptsLoading(false)
      setSessionPromptsError(null)
      return
    }
    const controller = new AbortController()
    setSessionPrompts([])
    setSessionPromptsLoading(true)
    setSessionPromptsError(null)
    labApi.listSessionPrompts(selectedSessionId, { signal: controller.signal })
      .then((result) => setSessionPrompts(result.items))
      .catch((error: unknown) => {
        if (isLabApiError(error) && error.kind === 'aborted') return
        setSessionPromptsError(errorText(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setSessionPromptsLoading(false)
      })
    return () => controller.abort()
  }, [selectedSessionId])

  useEffect(() => {
    if (!selectedTurnId) {
      setDetail(null)
      setSelectedRoundId(null)
      return
    }
    const controller = new AbortController()
    setDetailLoading(true)
    setDetailError(null)
    setPrompt(null)
    labApi.getTurnDetail(selectedTurnId, { signal: controller.signal })
      .then((nextDetail) => {
        setDetail(nextDetail)
        setSelectedRoundId(null)
      })
      .catch((error: unknown) => {
        if (isLabApiError(error) && error.kind === 'aborted') return
        setDetailError(errorText(error))
        setDetail(null)
        setSelectedRoundId(null)
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false)
      })
    return () => controller.abort()
  }, [selectedTurnId])

  useEffect(() => {
    if (!detail || !selectedRoundId) {
      setPrompt(null)
      setPromptLoading(false)
      setPromptError(null)
      return
    }
    const controller = new AbortController()
    setPrompt(null)
    setPromptLoading(true)
    setPromptError(null)
    labApi.reconstructPrompt(detail.id, selectedRoundId, { signal: controller.signal })
      .then(setPrompt)
      .catch((error: unknown) => {
        if (isLabApiError(error) && error.kind === 'aborted') return
        setPromptError(errorText(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setPromptLoading(false)
      })
    return () => controller.abort()
  }, [detail, selectedRoundId])

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null
  const trace = detail ? detailToTrace(detail) : null
  const promptPotential = useMemo(
    () => analyzePromptCachePotential(sessionPrompts),
    [sessionPrompts],
  )
  const promptPotentialRows = useMemo<TurnPromptPotentialRow[]>(() => {
    const byTurn = new Map(promptPotential.turns.map((turn) => [turn.turnId, turn]))
    const turnOrdinalById = new Map(turns.map((turn) => [turn.id, turn.sessionOrdinal]))
    const invocationByRoundId = new Map(promptPotential.invocations.map((invocation) => [invocation.roundId, invocation]))
    const promptByRoundId = new Map(sessionPrompts.map((item) => [item.roundId, item]))
    const messageSection = (section: string | undefined): boolean => (
      section !== undefined && section !== 'tools' && section !== 'request_end'
    )
    const sectionLabel = (section: string | undefined): string | null => {
      switch (section) {
        case 'persona': return t('prompt.block.persona')
        case 'context': return t('prompt.block.context')
        case 'session_history': return t('prompt.block.sessionHistory')
        case 'current_input': return t('prompt.block.currentInput')
        case 'current_turn': return t('prompt.block.currentTurn')
        case 'tools': return t('prompt.block.tools')
        case 'request_end': return t('analysis.requestEnd')
        default: return null
      }
    }

    return turns.map((turn) => {
      const potential = byTurn.get(turn.id)
      const hasComparableRequests = (potential?.comparableInvocations ?? 0) > 0
      return {
        turnId: turn.id,
        ordinal: turn.sessionOrdinal,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        estimatedInputTokens: potential?.estimatedRequestTokens ?? null,
        reusableTokens: hasComparableRequests ? potential?.estimatedReusableTokens ?? null : null,
        nonReusableTokens: hasComparableRequests ? potential?.estimatedNonReusableTokens ?? null : null,
        potentialRate: hasComparableRequests ? potential?.potentialRatio ?? null : null,
        nonReusableRate: hasComparableRequests ? potential?.nonReusableRatio ?? null : null,
        alignmentDeltaTokens: potential
          ? turn.inputTokens - potential.estimatedRequestTokens
          : null,
        alignmentDeltaRate: potential && turn.inputTokens > 0
          ? Math.abs(turn.inputTokens - potential.estimatedRequestTokens) / turn.inputTokens
          : null,
        comparableRounds: potential?.comparableInvocations ?? 0,
        totalRounds: potential?.totalInvocations ?? 0,
        rounds: (potential?.invocations ?? []).map((invocation) => {
          const currentPrompt = promptByRoundId.get(invocation.roundId)
          const baselinePrompt = invocation.baselineRoundId
            ? promptByRoundId.get(invocation.baselineRoundId)
            : null
          const structuralComparison = currentPrompt && baselinePrompt
            ? comparePromptReconstructions(baselinePrompt, currentPrompt)
            : null
          const firstChangedMessageSection = structuralComparison?.firstChangedBlock
            ?? (messageSection(invocation.firstDifference?.section)
              ? invocation.firstDifference?.section
              : undefined)

          return {
            roundId: invocation.roundId,
            ordinal: invocation.roundIndex,
            estimatedInputTokens: invocation.estimatedRequestTokens,
            outputTokens: potential?.totalInvocations === 1 && turn.status === 'completed'
              ? turn.outputTokens
              : null,
            reusableTokens: invocation.baselineRoundId === null ? null : invocation.estimatedReusableTokens,
            nonReusableTokens: invocation.baselineRoundId === null ? null : invocation.estimatedNonReusableTokens,
            potentialRate: invocation.baselineRoundId === null ? null : invocation.potentialRatio,
            nonReusableRate: invocation.baselineRoundId === null ? null : invocation.nonReusableRatio,
            hasBaseline: invocation.baselineRoundId !== null,
            baselineTurnOrdinal: invocation.baselineTurnId
              ? turnOrdinalById.get(invocation.baselineTurnId) ?? null
              : null,
            baselineRoundOrdinal: invocation.baselineRoundId
              ? invocationByRoundId.get(invocation.baselineRoundId)?.roundIndex ?? null
              : null,
            firstChangedBlock: sectionLabel(firstChangedMessageSection),
            toolSurfaceChanged: structuralComparison
              ? structuralComparison.toolSurface.status !== 'same'
              : invocation.firstDifference?.section === 'tools',
            nonReusableSections: invocation.nonReusableSections
              .filter((section) => messageSection(section.section))
              .map((section) => sectionLabel(section.section))
              .filter((section): section is string => section !== null),
          }
        }),
      }
    })
  }, [promptPotential.invocations, promptPotential.turns, sessionPrompts, t, turns])

  const promptComparison = useMemo(() => {
    if (!promptComparisonRoundId) return null
    const invocation = promptPotential.invocations.find(
      (candidate) => candidate.roundId === promptComparisonRoundId,
    )
    if (!invocation?.baselineRoundId) return null

    const currentPrompt = sessionPrompts.find((candidate) => candidate.roundId === invocation.roundId)
    const baselinePrompt = sessionPrompts.find(
      (candidate) => candidate.roundId === invocation.baselineRoundId,
    )
    if (!currentPrompt || !baselinePrompt) return null

    const blockTitles = Object.fromEntries(
      Object.entries(promptBlockTitleKeys).map(([kind, key]) => [kind, t(key)]),
    ) as Partial<Record<CanonicalPromptBlockKind, string>>
    const comparison = comparePromptReconstructions(baselinePrompt, currentPrompt, { blockTitles })
    const turnOrdinalById = new Map(turns.map((turn) => [turn.id, turn.sessionOrdinal]))
    const turnById = new Map(turns.map((turn) => [turn.id, turn]))
    const viewModel = buildPromptCacheComparisonViewModel(
      comparison,
      invocation,
      promptPotential.invocations,
      turnOrdinalById,
      (turnId, _targetInvocation, turnInvocationCount) => {
        const turn = turnById.get(turnId)
        return turnInvocationCount === 1 && turn?.status === 'completed'
          ? turn.outputTokens
          : null
      },
    )
    const localizeIdentity = (identity: typeof viewModel.baseline) => ({
      ...identity,
      label: t('analysis.promptDiffIdentity', {
        turn: identity.turnOrdinal ?? '?',
        ordinal: identity.roundOrdinal,
      }),
    })
    return {
      ...viewModel,
      baseline: localizeIdentity(viewModel.baseline),
      current: localizeIdentity(viewModel.current),
    }
  }, [promptComparisonRoundId, promptPotential.invocations, sessionPrompts, t, turns])

  const closePromptComparison = useCallback(() => setPromptComparisonRoundId(null), [])
  const compareRound = useCallback((roundId: string) => {
    setSelectedRoundId(roundId)
    setPromptComparisonRoundId(roundId)
  }, [])

  const selectSession = (session: SessionSummary) => {
    setSelectedSessionId(session.id)
    setSelectedTurnId(null)
    setDetail(null)
    setSelectedRoundId(null)
    setPrompt(null)
    setPromptComparisonRoundId(null)
    setActiveInspectorTab('overview')
  }

  const selectRound = (round: RoundTrace) => {
    setSelectedRoundId((current) => current === round.id ? null : round.id)
  }

  const selectTurn = (turnId: string) => {
    setSelectedTurnId(turnId)
    setSelectedRoundId(null)
    setPrompt(null)
    setPromptComparisonRoundId(null)
    setActiveInspectorTab('overview')
  }

  return (
    <>
      <div className="agent-loop-layout">
      <ResizablePane
        side="left"
        storageKey="bridgic-agent-lab.session-pane-width"
        defaultWidth={248}
        minWidth={184}
        maxWidth={420}
        labels={{
          resize: t('layout.resizeSidebar'),
          collapse: t('layout.collapseSidebar'),
          expand: t('layout.expandSidebar'),
        }}
        contentClassName="session-pane-content"
      >
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelectSession={selectSession}
          health={health}
          loading={sessionsLoading}
          error={sessionsError}
          onRetry={() => setReloadKey((value) => value + 1)}
        />
      </ResizablePane>
      {trace && selectedTurnId ? (
        <TraceWorkspace
          session={trace}
          turns={turns}
          selectedTurnId={selectedTurnId}
          onSelectTurn={selectTurn}
          selectedRoundId={selectedRoundId}
          onSelectRound={selectRound}
          prompt={prompt}
          promptLoading={promptLoading}
          promptError={promptError}
          estimatedInputTokens={promptPotentialRows.find((row) => row.turnId === selectedTurnId)?.estimatedInputTokens ?? null}
          activeDetailTab={activeInspectorTab}
          onDetailTabChange={setActiveInspectorTab}
        />
      ) : (
        <WorkspaceNotice
          title={sessionsLoading || turnsLoading || detailLoading ? t('data.loading') : t('data.unavailable')}
          detail={sessionsError || turnsError || detailError || (
            selectedSession
              ? t('run.noTurns')
              : t('sidebar.emptyDatabase')
          )}
          loading={sessionsLoading || turnsLoading || detailLoading}
        />
      )}
      <ResizablePane
        key="analysis-pane-v5"
        side="right"
        storageKey="bridgic-agent-lab.analysis-pane-width-v5"
        collapsedStorageKey="bridgic-agent-lab.analysis-pane-collapsed-v1"
        defaultWidth={defaultAnalysisPaneWidth()}
        defaultCollapsed
        minWidth={360}
        maxWidth={maxAnalysisPaneWidth()}
        labels={{
          resize: t('layout.resizeAnalysis'),
          collapse: t('layout.collapseAnalysis'),
          expand: t('layout.expandAnalysis'),
        }}
        contentClassName="analysis-pane-content"
      >
        <AnalysisPanel
          rows={promptPotentialRows}
          selectedTurnId={selectedTurnId}
          loading={sessionPromptsLoading}
          error={sessionPromptsError}
          onSelectTurn={selectTurn}
          onCompareRound={compareRound}
        />
      </ResizablePane>
      </div>
      <PromptCacheCompareModal
        open={promptComparison !== null}
        comparison={promptComparison}
        onClose={closePromptComparison}
        formatNumber={formatNumber}
        labels={{
          title: t('analysis.promptDiffTitle'),
          subtitle: t('analysis.promptDiffSubtitle'),
          close: t('analysis.promptDiffClose'),
          baseline: t('analysis.promptDiffBaseline'),
          current: t('analysis.promptDiffCurrent'),
          inputTokens: t('analysis.estimatedPromptTokens'),
          outputTokens: t('analysis.outputShort'),
          cacheHit: t('analysis.cacheHitTokens'),
          cacheMiss: t('analysis.cacheMissTokens'),
          messageBlocks: t('analysis.promptDiffMessageBlocks'),
          toolDefinitions: t('analysis.promptDiffToolDefinitions'),
          toolSchemaChanged: t('analysis.promptDiffToolSchemaChanged'),
          unchanged: t('analysis.promptDiffUnchanged'),
          changed: t('analysis.promptDiffChanged'),
          added: t('analysis.promptDiffAdded'),
          removed: t('analysis.promptDiffRemoved'),
          expand: t('analysis.promptDiffExpand'),
          collapse: t('analysis.promptDiffCollapse'),
          emptyContent: t('analysis.promptDiffEmpty'),
          noBlocks: t('analysis.promptDiffNoBlocks'),
          firstMessageDifference: t('analysis.promptDiffFirstMessageDifference'),
        }}
      />
    </>
  )
}

function WorkspaceNotice({ title, detail, loading }: { title: string; detail: string; loading: boolean }) {
  return (
    <main className="trace-workspace workspace-notice">
      <div className="workspace-notice-content">
        {loading ? <RefreshCw className="loading-icon" size={22} aria-hidden="true" /> : <Database size={22} aria-hidden="true" />}
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </main>
  )
}

function ModulePlaceholder({ module }: { module: LabModule }) {
  const Icon = module.icon
  const { t } = useI18n()
  return (
    <main className="module-placeholder">
      <div className="placeholder-mark"><Icon size={25} strokeWidth={1.5} aria-hidden="true" /></div>
      <span className="eyebrow">{t('placeholder.eyebrow')}</span>
      <h1>{t(module.labelKey)}</h1>
      <p>{t(module.descriptionKey)}</p>
      <span className="placeholder-status">{t('placeholder.status')}</span>
    </main>
  )
}

function AppContent() {
  const [activeModule, setActiveModule] = useState<LabModuleId>('agent-loop')
  const [theme, setTheme] = useState<Theme>('dark')
  const module = modules.find((candidate) => candidate.id === activeModule) ?? defaultModule

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#242422' : '#f7f8fb')
  }, [theme])

  return (
    <div className="lab-app" data-theme={theme}>
      <PlatformHeader
        activeModule={activeModule}
        onModuleChange={setActiveModule}
        theme={theme}
        onThemeChange={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
      />
      {activeModule === 'agent-loop' ? <AgentLoopLab /> : <ModulePlaceholder module={module} />}
    </div>
  )
}

export function App({ initialLocale }: { initialLocale?: Locale } = {}) {
  return (
    <I18nProvider initialLocale={initialLocale}>
      <AppContent />
    </I18nProvider>
  )
}
