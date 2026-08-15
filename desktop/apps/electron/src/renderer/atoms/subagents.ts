import { atom } from 'jotai'
import type { AgentTurnStatus, MessageBlock, SubAgentMode } from '@shared/types'
import { i18n } from '@/lib/i18n'

export interface SubagentState {
  invocationId: string
  /** Root or parent Session that receives this Child lifecycle projection. */
  parentSessionId: string
  parentToolCallId?: string
  mode: SubAgentMode
  goal: string
  status: string
  answer?: string | null
  error?: string | null
}

export interface SubagentEventPayload {
  invocationId: string
  parentSessionId: string
  parentToolCallId?: string
  mode: SubAgentMode
  goal: string
  status: string
  phase: 'started' | 'status'
  answer?: string
  error?: string
}

export const subagentsAtom = atom<Map<string, SubagentState>>(new Map())

export type SubagentLifecycleStatus = 'queued' | 'running' | AgentTurnStatus

export type SubagentLifecycleKind =
  | 'queued'
  | 'running'
  | 'awaiting_subagents'
  | 'awaiting_human'
  | 'awaiting_permission'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'unknown'

export type SubagentLifecycleTone = 'neutral' | 'attention' | 'success' | 'muted' | 'error'
export type SubagentLifecycleIndicator =
  | 'spinner'
  | 'queued'
  | 'attention'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'none'

interface SubagentLifecycleDefinition {
  kind: SubagentLifecycleKind
  label: string
  shortLabel: string
  tone: SubagentLifecycleTone
  indicator: SubagentLifecycleIndicator
  isActive: boolean
  isRunning: boolean
  needsUserAction: boolean
}

interface SubagentLifecycleSources {
  liveStatus?: string
  isExecuting: boolean
  turnStatus?: AgentTurnStatus
}

/** Canonical presentation and interaction semantics for one Child lifecycle state. */
export class SubagentLifecycle {
  private static readonly definitions: Record<SubagentLifecycleStatus, SubagentLifecycleDefinition> = {
    queued: {
      kind: 'queued',
      label: 'status.subagent.queued',
      shortLabel: 'status.subagent.queuedShort',
      tone: 'neutral',
      indicator: 'queued',
      isActive: true,
      isRunning: true,
      needsUserAction: false,
    },
    running: {
      kind: 'running',
      label: 'status.subagent.running',
      shortLabel: 'status.subagent.runningShort',
      tone: 'neutral',
      indicator: 'spinner',
      isActive: true,
      isRunning: true,
      needsUserAction: false,
    },
    awaiting_subagents: {
      kind: 'awaiting_subagents',
      label: 'status.subagent.awaitingSubagents',
      shortLabel: 'status.subagent.awaitingSubagentsShort',
      tone: 'neutral',
      indicator: 'spinner',
      isActive: true,
      isRunning: true,
      needsUserAction: false,
    },
    awaiting_human: {
      kind: 'awaiting_human',
      label: 'status.subagent.awaitingHuman',
      shortLabel: 'status.subagent.awaitingHumanShort',
      tone: 'attention',
      indicator: 'attention',
      isActive: true,
      isRunning: false,
      needsUserAction: true,
    },
    awaiting_permission: {
      kind: 'awaiting_permission',
      label: 'status.subagent.awaitingPermission',
      shortLabel: 'status.subagent.awaitingPermissionShort',
      tone: 'attention',
      indicator: 'attention',
      isActive: true,
      isRunning: false,
      needsUserAction: true,
    },
    completed: {
      kind: 'completed',
      label: 'status.subagent.completed',
      shortLabel: 'status.subagent.completedShort',
      tone: 'success',
      indicator: 'completed',
      isActive: false,
      isRunning: false,
      needsUserAction: false,
    },
    cancelled: {
      kind: 'stopped',
      label: 'status.subagent.stopped',
      shortLabel: 'status.subagent.stoppedShort',
      tone: 'muted',
      indicator: 'stopped',
      isActive: false,
      isRunning: false,
      needsUserAction: false,
    },
    failed: {
      kind: 'failed',
      label: 'status.subagent.failed',
      shortLabel: 'status.subagent.failedShort',
      tone: 'error',
      indicator: 'failed',
      isActive: false,
      isRunning: false,
      needsUserAction: false,
    },
  }

  private static readonly unknown: SubagentLifecycleDefinition = {
    kind: 'unknown',
    label: 'status.subagent.unknown',
    shortLabel: 'status.subagent.unknownShort',
    tone: 'muted',
    indicator: 'none',
    isActive: false,
    isRunning: false,
    needsUserAction: false,
  }

  readonly kind: SubagentLifecycleKind
  readonly label: string
  readonly shortLabel: string
  readonly tone: SubagentLifecycleTone
  readonly indicator: SubagentLifecycleIndicator
  readonly isActive: boolean
  readonly isRunning: boolean
  readonly needsUserAction: boolean

  private constructor(readonly status: string | undefined, definition: SubagentLifecycleDefinition) {
    this.kind = definition.kind
    this.label = i18n.t(definition.label)
    this.shortLabel = i18n.t(definition.shortLabel)
    this.tone = definition.tone
    this.indicator = definition.indicator
    this.isActive = definition.isActive
    this.isRunning = definition.isRunning
    this.needsUserAction = definition.needsUserAction
  }

  private static isStatus(status: string): status is SubagentLifecycleStatus {
    return Object.prototype.hasOwnProperty.call(this.definitions, status)
  }

  static from(status?: string): SubagentLifecycle {
    const definition = status && this.isStatus(status) ? this.definitions[status] : undefined
    if (definition) return new SubagentLifecycle(status, definition)
    return new SubagentLifecycle(status, this.unknown)
  }

  /** Resolve live, executing, and durable sources in authoritative order. */
  static fromSources(sources: SubagentLifecycleSources): SubagentLifecycle {
    if (sources.liveStatus !== undefined) return this.from(sources.liveStatus)
    if (sources.isExecuting) return this.from('running')
    return this.from(sources.turnStatus)
  }
}

/**
 * Whether a rendered parent reply is still waiting on a foreground Child Session.
 *
 * Persisted parent transcripts contain only blocking/RPC children; background
 * children stay in the sidebar. Live state overrides the persisted status so
 * this projection remains correct while lifecycle events arrive.
 */
export function hasActiveForegroundSubagent(
  blocks: MessageBlock[],
  live: ReadonlyMap<string, SubagentState>,
): boolean {
  const isActive = (child: { invocationId: string; status: string }): boolean => {
    const state = live.get(child.invocationId)
    if (state?.mode === 'background') return false
    return SubagentLifecycle.from(state?.status ?? child.status).isActive
  }

  for (const block of blocks) {
    if (block.type === 'subagent' && isActive(block)) return true
    if (block.type === 'tool' && block.subagents?.some(isActive)) return true
  }
  return false
}

/** A parent logical Turn remains active while its durable state is parked for
 * Child Sessions, even during the brief join window after every Child became
 * terminal. Older transcripts fall back to Child lifecycle status. */
export function isParentWaitingForSubagents(
  blocks: MessageBlock[],
  live: ReadonlyMap<string, SubagentState>,
  turnStatus?: AgentTurnStatus,
): boolean {
  return turnStatus !== undefined
    ? turnStatus === 'awaiting_subagents'
    : hasActiveForegroundSubagent(blocks, live)
}

export const applySubagentEventAtom = atom(null, (get, set, payload: SubagentEventPayload) => {
  const states = new Map(get(subagentsAtom))
  const current = states.get(payload.invocationId) ?? {
    invocationId: payload.invocationId,
    parentSessionId: payload.parentSessionId,
    mode: payload.mode,
    goal: payload.goal,
    status: payload.status,
  }
  const parentToolCallId = payload.parentToolCallId ?? current.parentToolCallId
  states.set(payload.invocationId, {
    ...current,
    parentSessionId: payload.parentSessionId,
    mode: payload.mode,
    ...(parentToolCallId ? { parentToolCallId } : {}),
    goal: payload.goal || current.goal,
    status: payload.status,
    answer: payload.answer ?? current.answer,
    error: payload.error ?? current.error,
  })
  set(subagentsAtom, states)
})
