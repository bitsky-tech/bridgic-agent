/**
 * Top-level composer wrapper.
 *
 * Owns:
 *   - active session id reading
 *   - send/stop callbacks (delegate to atoms)
 *   - reads `composer.inputSendKey` from settingsAtom
 *   - branches on `hasConfiguredModelAtom`: when no model is configured,
 *     renders `NoModelPlaceholder` instead of `FreeFormInput` so first-
 *     launch users see "please configure a model first" inside the input slot
 *     rather than a disabled-looking real editor.
 *   - additionally branches on `modelsHydrationStateAtom === 'error'`:
 *     daemon-unreachable / GET /providers throwing leaves the user with
 *     a normal-looking input that would silently fail on send. We show
 *     a dedicated error placeholder pointing at Settings → Gateway.
 *
 * Renders:
 *   - normal:    <FreeFormInput sessionId onSubmit onStop streaming sendKey />
 *   - no model:  <NoModelPlaceholder onConfigure={openSettingsOnModelTab} />
 *   - error:     <NoModelPlaceholder kind="error" />, reads hydrate error msg
 *
 * `inputSendKey` reacts live to settings changes (the atom is updated
 * by `useSettingsBridge` when main broadcasts `settings-changed`).
 * That's fine here — flipping the send-key only changes the next
 * keystroke's behavior, not the in-progress text.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { activeSessionIdAtom } from '@/atoms/sessions'
import {
  appendUserMessageAtom,
  cancelTurnAtom,
  currentAgentRunningAtom,
  hasPendingPermissionAtom,
} from '@/atoms/agent'
import { settingsAtom } from '@/atoms/settings'
import { runScheduleNowAtom } from '@/atoms/schedules'
import { associateSessionWorkflowsFromInputAtom } from '@/atoms/workflows'
import {
  hasConfiguredModelAtom,
  hydrateModelsAtom,
  modelsHydrationErrorAtom,
  modelsHydrationStateAtom,
} from '@/atoms/models'
import { ModalKind, openModalAtom } from '@/atoms/amphi'
import { SettingsTabId } from '../amphi/Modals'
import { FreeFormInput } from './FreeFormInput'
import { NoModelPlaceholder } from './NoModelPlaceholder'
import { ComposerModePill } from '@/components/permissions'
import type { ChatBlock } from '@shared/types'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ChatInputZoneProps {
  // intentionally empty — host owns send/stop wiring via atoms.
}

export function ChatInputZone(_props: ChatInputZoneProps) {
  const { t } = useTranslation()
  const sessionId = useAtomValue(activeSessionIdAtom)
  const streaming = useAtomValue(currentAgentRunningAtom)
  // Input is disabled while an approval is parked: the user must decide on the approval card above first (the server also rejects stray messages).
  const pendingPermission = useAtomValue(hasPendingPermissionAtom)
  const hasModel = useAtomValue(hasConfiguredModelAtom)
  const hydrationState = useAtomValue(modelsHydrationStateAtom)
  const hydrationError = useAtomValue(modelsHydrationErrorAtom)
  const appendUserMessage = useSetAtom(appendUserMessageAtom)
  const associateSessionWorkflows = useSetAtom(associateSessionWorkflowsFromInputAtom)
  const cancelTurn = useSetAtom(cancelTurnAtom)
  const openModal = useSetAtom(openModalAtom)
  const hydrateModels = useSetAtom(hydrateModelsAtom)
  const runScheduleNow = useSetAtom(runScheduleNowAtom)
  const sendKey = useAtomValue(settingsAtom).composer.inputSendKey

  const handleSubmit = (text: string, blocks: ChatBlock[]) => {
    if (!sessionId) return
    const firstMeaningful = blocks.find(
      (block) => block.type !== 'text' || block.value.trim().length > 0,
    )
    if (firstMeaningful?.type === 'slash' && firstMeaningful.resource === 'schedule') {
      void runScheduleNow(firstMeaningful.id)
      return
    }
    associateSessionWorkflows({ sessionId, blocks })
    appendUserMessage({ sessionId, text, blocks })
  }

  const handleStop = () => {
    if (!sessionId) return
    // Abort the in-flight daemon turn: local finalize + POST /stop (the
    // daemon cancels the agent task for real — see cancelTurnAtom).
    cancelTurn(sessionId)
  }

  // A hydrate failure takes precedence over the no-model display. Both converge on the same-shaped
  // NoModelPlaceholder card, so the input position's layout does not jitter back and forth.
  //
  // Note: during a retry, hydrate changes the state from 'error' to 'loading', so in theory
  // `hydrationState === 'error'` is no longer true and we would switch to the hasModel branch, briefly
  // flashing the normal input box. In practice hydrate's three GETs (catalog + me + providers) usually
  // return in <100ms, which is hard to notice; if this ever becomes a real problem, ChatInputZone could
  // keep showing the error card for a short while after a retry is triggered.
  if (hydrationState === 'error' || (hydrationState === 'loading' && !!hydrationError)) {
    return (
      <NoModelPlaceholder
        kind="error"
        message={hydrationError ?? t('composer.noModel.loadFailed')}
        onConfigure={() => { void hydrateModels() }}
        retrying={hydrationState === 'loading'}
        ctaLabel={t('composer.noModel.retry')}
      />
    )
  }

  // With no model we take over the input position outright — no toolbar / editable area is rendered, so the user is not
  // given the confusing impression of "ready but disabled". The placeholder itself is the CTA.
  if (!hasModel) {
    return (
      <NoModelPlaceholder
        onConfigure={() => openModal({ type: ModalKind.Settings, initialTab: SettingsTabId.Model })}
      />
    )
  }

  return (
    <FreeFormInput
      sessionId={sessionId}
      onSubmit={handleSubmit}
      onStop={handleStop}
      streaming={streaming}
      // The input is **not** disabled while a turn runs: the user can type the next message while waiting (the backend is
      // serial-chat, so sending still has to wait for this turn to end — that gate lives in FreeFormInput's submit /
      // canSubmit and is independent of this prop). Previously streaming was folded in here and the user could only sit and wait.
      // Only a parked approval still disables it: the user must decide on the approval card above, and the server also rejects stray messages.
      disabled={pendingPermission}
      disabledHint={pendingPermission ? t('composer.pendingPermissionHint') : undefined}
      sendKey={sendKey}
      toolbarRight={<ComposerModePill />}
    />
  )
}
