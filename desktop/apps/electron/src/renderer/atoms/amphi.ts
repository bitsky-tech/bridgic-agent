/**
 * amphi-only UI state: top-level navigation + modal stack.
 *
 * Session metadata + drafts live in `./sessions.ts` (index file + one
 * append-only log per session). Pipeline messages / streaming state live
 * in `./agent.ts`.
 * This file is intentionally small — only the cross-component nav +
 * modal state that the design baseline owns.
 */
import { atom } from 'jotai'
import type { ShowcaseWorkflow } from '@/lib/showcaseClient'
import type { SettingsTabId } from '../components/amphi/Modals'
import { hasConversationAtom } from './agent'
import { activeSessionIsRootAtom } from './sessions'
import { updateSettingsAtom } from './settings'
import { activeNavAtom, NavKey, viewedSessionIdAtom } from './navigation'

export { activeNavAtom, toNavKey, viewedSessionIdAtom } from './navigation'

/** Single visibility decision for the complete Session dock (content plus tool rail).
 *
 * The dock belongs only to a real root conversation under Home. A fresh draft stays on the
 * uncluttered landing page; sending its first message transitions it into conversation state
 * and reveals the dock. Non-Home views and Child Sessions never own this surface.
 *
 * App and dock content both consume this atom directly so no composition layer can add a
 * second, drifting visibility gate. */
export const showRightPanelAtom = atom(
  (get) =>
    get(activeNavAtom) === NavKey.Home &&
    get(activeSessionIsRootAtom) &&
    get(viewedSessionIdAtom) !== null &&
    get(hasConversationAtom),
)

/* ─── Right panel filter ─── */

/** Session-output filter-chip discriminator: all, or a single output group. */
export const RightPanelFilter = {
  All: 'all',
  Workflow: 'workflow',
  WorkflowRun: 'workflowRun',
  Files: 'files',
} as const
export type RightPanelFilter = (typeof RightPanelFilter)[keyof typeof RightPanelFilter]

/** Which group the right panel shows ("all" → every non-empty group). */
export const rightPanelFilterAtom = atom<RightPanelFilter>(RightPanelFilter.All)

export const selectRightPanelFilterAtom = atom(null, (_get, set, filter: RightPanelFilter) => {
  set(rightPanelFilterAtom, filter)
})

/* ─── Modal kind + payload sub-kinds (typed-const for cross-file safety) ─── */

/**
 * Top-level modal discriminator. Pass `ModalKind.X` to `openModal`
 * rather than the raw string — typecheck catches renames + missing
 * `case` branches in `ActiveModal` switch.
 */
export const ModalKind = {
  Settings: 'settings',
  WorkflowDetail: 'workflowDetail',
  WorkflowRunDetail: 'workflowRunDetail',
  MarketPreview: 'marketPreview',
  DeleteConfirm: 'deleteConfirm',
  EditField: 'editField',
  PreviewField: 'previewField',
  DependencyCheck: 'dependencyCheck',
  SessionDelete: 'sessionDelete',
  FileOpenConfirm: 'fileOpenConfirm',
  SkillImport: 'skillImport',
  SkillDelete: 'skillDelete',
  Subagent: 'subagent',
} as const
export type ModalKind = (typeof ModalKind)[keyof typeof ModalKind]

/** Field a user is editing in the right-panel build card. */
export const EditFieldKind = {
  Task: 'task',
} as const
export type EditFieldKind = (typeof EditFieldKind)[keyof typeof EditFieldKind]

/** Read-only field a user is previewing in the right-panel build card. */
export const PreviewFieldKind = {
  Explore: 'explore',
  Program: 'program',
} as const
export type PreviewFieldKind = (typeof PreviewFieldKind)[keyof typeof PreviewFieldKind]

/** Target of a delete confirmation dialog. */
export const DeleteTargetKind = {
  Workflow: 'workflow',
  Session: 'session',
} as const
export type DeleteTargetKind = (typeof DeleteTargetKind)[keyof typeof DeleteTargetKind]

/** Where a reusable Workflow entity should be inserted for the next message. */
export const ComposerTarget = {
  CurrentSession: 'current_session',
  NewSession: 'new_session',
} as const
export type ComposerTarget = (typeof ComposerTarget)[keyof typeof ComposerTarget]

/* ─── Modal layer ─── */

export type ModalKey =
  | { type: typeof ModalKind.Settings; initialTab?: SettingsTabId }
  | {
      type: typeof ModalKind.WorkflowDetail
      workflowId?: string
      workflowName?: string
      composerTarget: ComposerTarget
    }
  | {
      type: typeof ModalKind.WorkflowRunDetail
      runId: string
      initialFilePath?: string
      composerTarget: ComposerTarget
    }
  | { type: typeof ModalKind.MarketPreview; workflow?: ShowcaseWorkflow }
  | { type: typeof ModalKind.DeleteConfirm; target: DeleteTargetKind; name?: string; relatedCount?: number }
  | { type: typeof ModalKind.EditField; field: EditFieldKind; title: string; hasChange?: boolean }
  | { type: typeof ModalKind.PreviewField; field: PreviewFieldKind }
  | { type: typeof ModalKind.DependencyCheck; allGood?: boolean }
  | { type: typeof ModalKind.SessionDelete; id: string; name?: string }
  | { type: typeof ModalKind.FileOpenConfirm; path: string; name: string }
  | { type: typeof ModalKind.SkillImport }
  | { type: typeof ModalKind.SkillDelete; skillId: number; name: string }
  | { type: typeof ModalKind.Subagent; invocationId: string; goal?: string; status?: string }

export const activeModalAtom = atom<ModalKey | null>(null)

export const openModalAtom = atom(null, (_get, set, modal: ModalKey) => {
  set(activeModalAtom, modal)
})

export const closeModalAtom = atom(null, (_get, set) => {
  set(activeModalAtom, null)
})

/* ─── Settings form unsaved-dirty flag ─── */

/** Whether the current form (channel credentials) inside the settings modal has unsaved
 *  changes. ChannelCredentialForm reports its own dirty state while mounted, and
 *  SettingsModal's close / switch-tab entries read it to decide whether to raise a
 *  confirmation — preventing the user from losing edits (especially a model name where they
 *  forgot to click Add) by closing the window outright. */
const _settingsFormDirty = atom(false)

/** Read —— read by SettingsModal when it intercepts a close / tab switch. */
export const settingsFormDirtyAtom = atom((get) => get(_settingsFormDirty))

/** Write —— the form syncs its own dirty state while mounted, and resets it to false on unmount. */
export const setSettingsFormDirtyAtom = atom(null, (_get, set, dirty: boolean) => {
  set(_settingsFormDirty, dirty)
})

/* ─── Mutation helpers ─── */

export const selectNavAtom = atom(null, (_get, set, nav: NavKey) => {
  set(updateSettingsAtom, (prev) => ({ ...prev, ui: { ...prev.ui, lastNav: nav } }))
})
