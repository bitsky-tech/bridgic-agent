/**
 * Floating card for the desktop auto-update lifecycle.
 *
 * Mounted OUTSIDE `GatewayBootGate` on purpose: an update is exactly the kind of
 * thing a user needs to see while the gateway is down or version-blocked, and
 * the gate hides everything it wraps.
 *
 * Invariants:
 *   - **Only "ready to install" ever interrupts.** Downloading is silent, and so
 *     is every background failure (check / download / checksum): the user did
 *     not ask for those and cannot act on them. The one failure we DO surface is
 *     a refusal of the user's own click — a button that silently does nothing
 *     reads as broken.
 *   - Installing is always user-initiated. `autoInstallOnAppQuit` is off in the
 *     main process, so nothing installs unless a button here is pressed — on
 *     Windows the installer force-kills every process under the install
 *     directory, our daemon included.
 *   - The renderer never calls `app.quit` for an update. `update.installNow`
 *     owns the whole handover: stop the daemon gracefully, then quit + install.
 *   - Restarting under a running agent is possible but never the *default*:
 *     "update when idle" is the primary button, restarting now is the muted one.
 *   - **The parked update lives in its own state, not in the view.** The
 *     "scheduled" card auto-dismisses after a few seconds; if the poll were
 *     keyed off the visible card, that dismissal would silently cancel the very
 *     thing the card just promised.
 *   - **The card steps around the embedded Browser, it does not blank it.** That
 *     native view composites above this page, so the card was invisible under it
 *     until it started dodging. Hiding the view instead (what a modal dialog
 *     does) is wrong here: this card is deliberately non-blocking and can sit in
 *     the corner indefinitely, so the page behind it would stay blank for as
 *     long as the user ignored the card.
 *   - Exactly ONE control cancels the update, and it is on the ready card. The
 *     acknowledgement cards only close themselves — an "cancel" button on the
 *     scheduled card cannot be read unambiguously (cancel the schedule, or
 *     cancel the update?).
 *
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { AutoUpdateEvent, UpdateInstallResult } from '@shared/types'
import { APP_PRODUCT_NAME } from '@shared/app-meta'
import {
  beginUpdateHandoverAtom,
  endUpdateHandoverAtom,
  fetchAgentActivityAtom,
  updateCardReopenAtom,
} from '@/atoms/update'
import { rlog } from '@/lib/logger'
import { useBrowserSurfaceBlocker } from '@/hooks/useBrowserSurfaceBlocker'
import { useCountdownDismiss } from '@/hooks/useCountdownDismiss'
import { useOverlayRightLimit } from '@/hooks/useOverlayRightLimit'
import { Btn, Card } from '@/components/amphi'

/** How often the parked update re-checks whether the agent went idle. */
const IDLE_POLL_MS = 10_000

/** How long an acknowledgement card stays up before closing itself. */
const AUTO_DISMISS_SECONDS = 5

/** Gap from whichever edge the card is currently hugging (matches `bottom-4`). */
const EDGE_GAP_PX = 16

/** Card's widest form (matches `max-w-[380px]`); the width it needs to step aside into. */
const CARD_WIDTH_PX = 380

/**
 * Consecutive idle readings required before a parked update installs itself.
 *
 * One reading is not enough: it lands in the gap between two queued turns just
 * as often as it lands on real idleness, and acting on it would restart the app
 * out from under the task the user was about to see start.
 */
const IDLE_STREAK_REQUIRED = 2

/**
 * What the card is currently showing. `null` = nothing worth interrupting for.
 *
 * `scheduled` and `cancelled` are acknowledgements: they carry no decision and
 * close themselves. Whether an update is actually parked is tracked separately
 * (see `parkedVersion`), precisely so those two can disappear without
 * cancelling anything.
 */
type BannerView =
  | { kind: 'ready'; version: string }
  | { kind: 'confirm-busy'; version: string }
  | { kind: 'scheduled'; version: string }
  | { kind: 'cancelled' }
  | { kind: 'refused'; message: string }
  | null

/**
 * Map an updater event to what (if anything) the user should see.
 *
 * Only `downloaded` produces a card. `progress` is deliberately silent (the
 * download was never requested, so a progress bar is noise), and so is `error` —
 * a failed background check is not the user's problem to solve.
 */
function nextView(current: BannerView, event: AutoUpdateEvent): BannerView {
  if (event.type === 'downloaded') return { kind: 'ready', version: event.info.version }
  return current
}

/** Translate a typed refusal into copy the user can act on. */
function refusalKey(reason: Exclude<UpdateInstallResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'daemon-busy':
      return 'update.daemonBusy'
    case 'no-update-staged':
      return 'update.noneStaged'
    case 'update-disabled':
      return 'update.disabled'
    default:
      return 'update.errorTitle'
  }
}

export function AutoUpdateBanner() {
  const { t } = useTranslation()
  const [view, setView] = useState<BannerView>(null)
  const [installing, setInstalling] = useState(false)
  /** Non-null while an update is parked waiting for the agent to go idle. */
  const [parkedVersion, setParkedVersion] = useState<string | null>(null)
  // A ref, not the `installing` state: two clicks inside one React batch both
  // read the same stale `false`, which would fire two handovers — the first
  // already quitting the app while the second is still stopping the daemon.
  const installInFlight = useRef(false)
  const idleStreak = useRef(0)
  const reopenCount = useAtomValue(updateCardReopenAtom)
  const beginHandover = useSetAtom(beginUpdateHandoverAtom)
  const fetchAgentActivity = useSetAtom(fetchAgentActivityAtom)
  const endHandover = useSetAtom(endUpdateHandoverAtom)
  // Bottom-right is exactly where the embedded Browser's native view sits, and
  // that view composites above this page — `z-50` buys nothing against it. The
  // card steps left of the surface rather than blocking it: this card is not
  // modal and can sit there for as long as the user ignores it, and blanking a
  // whole web page behind it would read as a bug rather than as a decision.
  const rightLimit = useOverlayRightLimit()
  // Expanded Browser leaves only the sidebar's width beside the surface — none
  // at all with the sidebar collapsed — so there is nowhere to step to and the
  // card falls back to hiding the view instead.
  //
  // A latch (`squeezed ||`), measured ONLY while not already hiding the view:
  // blocking clears the rect, so re-deciding from the rect would unblock →
  // re-measure → block, every frame. Adjusted during render rather than in an
  // effect so the blocker below acts on the decision in the same commit. The
  // cost of the latch is that un-expanding the browser while a card is up
  // leaves it blocked until the card closes.
  const [squeezed, setSqueezed] = useState(false)
  const nextSqueezed = view !== null
    && (squeezed || rightLimit - EDGE_GAP_PX * 2 < CARD_WIDTH_PX)
  if (nextSqueezed !== squeezed) setSqueezed(nextSqueezed)
  useBrowserSurfaceBlocker('auto-update-banner', nextSqueezed)

  useEffect(() => {
    return window.api.events.onAutoUpdate((event) => {
      // `install-failed` always follows a click, so unlike the silent background
      // failures it MUST surface — and it has to unwind the in-flight guard, or
      // the button stays a no-op for the rest of the session.
      if (event.type === 'install-failed') {
        installInFlight.current = false
        setInstalling(false)
        setParkedVersion(null)
        endHandover()
        setView({ kind: 'refused', message: t('update.installFailed') })
        return
      }
      setView((current) => nextView(current, event))
    })
  }, [t, endHandover])

  // Settings → About asks for the card back rather than duplicating the
  // "is an agent running?" decision. It only asks when something is staged, but
  // ask the main process anyway — About may have been looking at a stale value.
  useEffect(() => {
    if (reopenCount === 0) return
    void window.api.update.getStatus().then((status) => {
      if (status.stagedVersion === null) return
      setView({ kind: 'ready', version: status.stagedVersion })
    })
  }, [reopenCount])

  const runInstall = useCallback(async () => {
    if (installInFlight.current) return
    installInFlight.current = true
    setInstalling(true)
    // Before the IPC call, not after: the handler's first act is to stop the
    // daemon, and the gateway-down screen must never be reachable in between.
    beginHandover()
    try {
      const result = await window.api.update.installNow()
      if (!result.ok) {
        // Release the guard: a refusal is recoverable (stop the gateway, retry),
        // and leaving it latched turned the button into a permanent no-op.
        installInFlight.current = false
        setInstalling(false)
        // Unpark too: a parked update that keeps hitting the same refusal every
        // 10s would retry forever behind a card the user already dismissed.
        setParkedVersion(null)
        endHandover()
        setView({ kind: 'refused', message: t(refusalKey(result.reason)) })
      }
      // On success the app is quitting; leave the guard latched so nothing can
      // start a second handover during it.
    } catch (err) {
      rlog.error('[auto-update] installNow failed', err)
      installInFlight.current = false
      setInstalling(false)
      setParkedVersion(null)
      endHandover()
      setView({ kind: 'refused', message: t('update.errorTitle') })
    }
  }, [t, beginHandover, endHandover])

  /** Restarting is gated on the daemon being idle — ask before interrupting work. */
  const handleRestartRequest = useCallback(async () => {
    const isAgentRunning = await fetchAgentActivity()
    if (!isAgentRunning) {
      void runInstall()
      return
    }
    setView((current) =>
      current?.kind === 'ready' ? { kind: 'confirm-busy', version: current.version } : current,
    )
  }, [runInstall, fetchAgentActivity])

  // Parked update: poll until the agent has been idle long enough, then install.
  // Keyed off `parkedVersion`, NOT the visible card — the card goes away on its
  // own after a few seconds and the schedule has to outlive it.
  useEffect(() => {
    if (parkedVersion === null) return
    idleStreak.current = 0
    const timer = setInterval(() => {
      void fetchAgentActivity().then((isAgentRunning) => {
        if (isAgentRunning) {
          idleStreak.current = 0
          return
        }
        idleStreak.current += 1
        if (idleStreak.current >= IDLE_STREAK_REQUIRED) {
          clearInterval(timer)
          void runInstall()
        }
      })
    }, IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [parkedVersion, runInstall, fetchAgentActivity])

  const handleWaitForIdle = (version: string) => {
    setParkedVersion(version)
    setView({ kind: 'scheduled', version })
  }

  const handleCancel = () => {
    setParkedVersion(null)
    setView({ kind: 'cancelled' })
  }

  return (
    <>
      {view !== null && (
        <div
          className="fixed bottom-4 z-50 max-w-[380px] transition-[right] duration-200 ease-out motion-reduce:transition-none"
          // Viewport-derived offset — the §1.22 dynamic-value exception. Animated
          // rather than snapped: the browser opening under a card the user is
          // already reading should look like the card making room, not like it
          // being thrown across the window.
          style={{
            right: nextSqueezed
              ? EDGE_GAP_PX
              : Math.max(EDGE_GAP_PX, window.innerWidth - rightLimit + EDGE_GAP_PX),
          }}
          data-testid="auto-update-banner"
        >
          <BannerBody
            view={view}
            installing={installing}
            onRestartRequest={() => void handleRestartRequest()}
            onRestartAnyway={() => void runInstall()}
            onWaitForIdle={handleWaitForIdle}
            onCancel={handleCancel}
            onClose={() => setView(null)}
          />
        </div>
      )}
    </>
  )
}

interface BannerBodyProps {
  view: NonNullable<BannerView>
  installing: boolean
  onRestartRequest: () => void
  onRestartAnyway: () => void
  onWaitForIdle: (version: string) => void
  onCancel: () => void
  onClose: () => void
}

/** One card per state. Split out so each branch is a plain early return. */
function BannerBody({
  view,
  installing,
  onRestartRequest,
  onRestartAnyway,
  onWaitForIdle,
  onCancel,
  onClose,
}: BannerBodyProps) {
  const { t } = useTranslation()

  if (view.kind === 'confirm-busy') {
    return (
      <Card className="p-3 flex flex-col gap-2">
        <div className="text-sm font-semibold text-text-primary">{t('update.busyTitle')}</div>
        <div className="text-xs text-text-secondary leading-relaxed">
          {t('update.busyDescription')}
        </div>
        <div className="flex gap-2 justify-end">
          {/* Muted on purpose: interrupting a running agent is the exception. */}
          <Btn variant="default" size="xs" onClick={onRestartAnyway} data-testid="auto-update-restart-anyway">
            {installing ? t('update.installing') : t('update.restartAnyway')}
          </Btn>
          <Btn
            variant="primary"
            size="xs"
            onClick={() => onWaitForIdle(view.version)}
            data-testid="auto-update-when-idle"
          >
            {t('update.updateWhenIdle')}
          </Btn>
        </div>
      </Card>
    )
  }

  if (view.kind === 'scheduled') {
    return (
      <AcknowledgementCard
        title={t('update.scheduledTitle')}
        body={t('update.scheduledDescription', { version: view.version })}
        onClose={onClose}
        testId="auto-update-scheduled"
      />
    )
  }

  if (view.kind === 'cancelled') {
    return (
      <AcknowledgementCard
        title={t('update.cancelledTitle')}
        body={t('update.cancelledHint')}
        onClose={onClose}
        testId="auto-update-cancelled"
      />
    )
  }

  if (view.kind === 'refused') {
    return (
      <Card className="p-3 flex flex-col gap-2">
        <div className="text-sm font-semibold text-status-error">{t('update.errorTitle')}</div>
        <div className="text-xs text-text-secondary leading-relaxed">{view.message}</div>
        <div className="flex justify-end">
          <Btn variant="ghost" size="xs" onClick={onClose}>
            {t('update.gotIt')}
          </Btn>
        </div>
      </Card>
    )
  }

  return (
    <Card className="p-3 flex flex-col gap-2">
      <div className="text-sm font-semibold text-text-primary">{t('update.readyTitle')}</div>
      <div className="text-xs text-text-secondary leading-relaxed">
        {t('update.readyDescription', { version: view.version, product: APP_PRODUCT_NAME })}
      </div>
      <div className="flex gap-2 justify-end">
        <Btn variant="ghost" size="xs" onClick={onCancel} data-testid="auto-update-cancel">
          {t('update.cancel')}
        </Btn>
        <Btn variant="primary" size="xs" onClick={onRestartRequest} data-testid="auto-update-install">
          {installing ? t('update.installing') : t('update.restartNow')}
        </Btn>
      </div>
    </Card>
  )
}

interface AcknowledgementCardProps {
  title: string
  body: string
  onClose: () => void
  testId: string
}

/**
 * A card with nothing left to decide: it states what happened and closes itself.
 *
 * The button is labelled "got it", never "cancel" — these cards appear AFTER the
 * user's choice has been recorded, so a cancel-looking control here would be
 * unreadable (does it undo the choice, or just close the card?).
 */
function AcknowledgementCard({ title, body, onClose, testId }: AcknowledgementCardProps) {
  const { t } = useTranslation()
  const remaining = useCountdownDismiss(AUTO_DISMISS_SECONDS, onClose)

  return (
    <Card className="p-3 flex flex-col gap-2" data-testid={testId}>
      <div className="text-sm font-semibold text-text-primary">{title}</div>
      <div className="text-xs text-text-secondary leading-relaxed">{body}</div>
      <div className="flex justify-end">
        <Btn variant="ghost" size="xs" onClick={onClose}>
          {t('update.gotItIn', { seconds: remaining })}
        </Btn>
      </div>
    </Card>
  )
}

export { nextView }
