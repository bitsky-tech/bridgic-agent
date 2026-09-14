import type { EmbeddedPowerPointSessionInfo, ExcelHostSessionInfo, WordHostSessionInfo } from '@shared/types'

export const OFFICE_APP_KINDS = ['presentation', 'word', 'excel'] as const
export type OfficeAppKind = typeof OFFICE_APP_KINDS[number]

export function isOfficeAppKind(value: string): value is OfficeAppKind {
  return OFFICE_APP_KINDS.some((kind) => kind === value)
}

/** Read-only shell facts; unknown/unsupported values must not imply an empty or idle editor. */
export interface OfficeSurfaceStatus {
  appKind: OfficeAppKind
  sessionId: string | null
  hasNativeTarget: boolean | null
  runtimeState: 'closed' | 'loading' | 'ready' | 'crashed' | 'unknown'
  documentCount: number | null
  documentInventory: 'unsupported' | 'pending' | 'ready'
  agentActivity: 'active' | 'idle' | 'unavailable'
  needsAttention: boolean | null
  dirty: boolean | null
}

export type OfficeSurfaceStatuses = Readonly<Record<OfficeAppKind, OfficeSurfaceStatus>>

/** Adapt existing producers without changing their protocols or inventing document counts. */
export function projectOfficeSurfaceStatuses({
  sessionId,
  powerPointSession,
  excelSession,
  wordSession,
  powerPointAgentActive,
  powerPointNeedsAttention,
}: {
  sessionId: string | null
  powerPointSession: EmbeddedPowerPointSessionInfo | null
  excelSession: ExcelHostSessionInfo | null
  wordSession: WordHostSessionInfo | null
  powerPointAgentActive: boolean
  powerPointNeedsAttention: boolean
}): OfficeSurfaceStatuses {
  const ppt = sessionId && powerPointSession?.sessionId === sessionId ? powerPointSession : null
  const excel = sessionId && excelSession?.sessionId === sessionId ? excelSession : null
  const word = sessionId && wordSession?.sessionId === sessionId ? wordSession : null
  return {
    presentation: {
      appKind: 'presentation',
      sessionId,
      hasNativeTarget: ppt !== null,
      runtimeState: nativeRuntimeState(ppt, ppt?.loading ?? false),
      documentCount: null,
      documentInventory: 'unsupported',
      agentActivity: sessionId && powerPointAgentActive ? 'active' : 'idle',
      needsAttention: sessionId !== null && powerPointNeedsAttention,
      dirty: null,
    },
    word: {
      appKind: 'word',
      sessionId,
      hasNativeTarget: word !== null,
      runtimeState: nativeRuntimeState(word, word?.loading ?? false),
      documentCount: word?.documentCount ?? null,
      documentInventory: word?.documentCount != null ? 'ready' : 'pending',
      agentActivity: 'unavailable',
      needsAttention: null,
      dirty: null,
    },
    excel: {
      appKind: 'excel',
      sessionId,
      hasNativeTarget: excel !== null,
      runtimeState: nativeRuntimeState(excel, excel?.ready === false),
      documentCount: null,
      documentInventory: 'unsupported',
      agentActivity: 'unavailable',
      needsAttention: null,
      dirty: excel?.dirty ?? null,
    },
  }
}

function nativeRuntimeState(target: { crashed: boolean } | null, loading: boolean): OfficeSurfaceStatus['runtimeState'] {
  if (!target) return 'closed'
  if (target.crashed) return 'crashed'
  return loading ? 'loading' : 'ready'
}

/** Preserve native-target markers until those runtimes publish authoritative document counts. */
export function hasOfficeBackgroundContent(status: OfficeSurfaceStatus): boolean {
  if (status.sessionId === null) return false
  if (status.documentCount !== null) return status.documentCount > 0
  return status.documentInventory === 'unsupported' && status.hasNativeTarget === true
}
