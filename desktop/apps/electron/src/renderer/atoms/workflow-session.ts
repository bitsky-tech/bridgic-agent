import { atom } from 'jotai'
import { NavKey } from '@/components/amphi/LeftSidebar'
import { MentionGroup, type Segment } from '@/components/composer/segments'
import { workflowRunMentionLabel } from '@/lib/workflowRun'
import { i18n } from '@/lib/i18n'
import { closeModalAtom, ComposerTarget, selectNavAtom, type ComposerTarget as ComposerTargetType } from './amphi'
import {
  newSessionAtom,
  requestComposerInsertAtom,
  setPendingComposerFocusAtom,
  setPendingComposerSeedAtom,
} from './sessions'

export interface WorkflowRunSessionTarget {
  id: string
  name: string
}

export interface WorkflowResultSessionTarget {
  id: string
  workflowName: string
  createdAt: string
}

/** Insert a Workflow command in the originating Session or a guided new Session. */
export const runWorkflowAtom = atom(
  null,
  (
    _get,
    set,
    payload: { workflow: WorkflowRunSessionTarget; composerTarget: ComposerTargetType },
  ) => {
    const command: Segment[] = [
      {
        type: 'slash',
        id: payload.workflow.id,
        label: payload.workflow.name,
        resource: 'workflow',
      },
      { type: 'text', value: ' ' },
    ]

    set(closeModalAtom)
    set(selectNavAtom, NavKey.Home)
    if (payload.composerTarget === ComposerTarget.CurrentSession) {
      set(requestComposerInsertAtom, command)
      return
    }

    const focusFieldId = 'workflow-run-input'
    const sessionId = set(newSessionAtom)
    set(setPendingComposerSeedAtom, {
      sessionId,
      segments: [
        ...command,
        {
          type: 'field',
          id: focusFieldId,
          placeholder: i18n.t('common.workflowRunInputPlaceholder'),
          value: '',
        },
      ],
      focusFieldId,
    })
    set(setPendingComposerFocusAtom, true)
  },
)

/** Insert a completed Workflow result reference in the requested composer. */
export const useWorkflowResultAtom = atom(
  null,
  (
    _get,
    set,
    payload: { result: WorkflowResultSessionTarget; composerTarget: ComposerTargetType },
  ) => {
    const reference: Segment[] = [
      {
        type: 'mention',
        id: payload.result.id,
        label: workflowRunMentionLabel({
          workflow_name: payload.result.workflowName,
          created_at: payload.result.createdAt,
        }),
        group: MentionGroup.WorkflowRun,
      },
      { type: 'text', value: ' ' },
    ]

    set(closeModalAtom)
    set(selectNavAtom, NavKey.Home)
    if (payload.composerTarget === ComposerTarget.CurrentSession) {
      set(requestComposerInsertAtom, reference)
      return
    }

    const focusFieldId = 'workflow-result-input'
    const sessionId = set(newSessionAtom)
    set(setPendingComposerSeedAtom, {
      sessionId,
      segments: [
        ...reference,
        {
          type: 'field',
          id: focusFieldId,
          placeholder: i18n.t('common.workflowResultInputPlaceholder'),
          value: '',
        },
      ],
      focusFieldId,
    })
    set(setPendingComposerFocusAtom, true)
  },
)
