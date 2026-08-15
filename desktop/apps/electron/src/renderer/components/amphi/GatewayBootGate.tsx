/**
 * GatewayBootGate — full-screen wrapper that gates the main app on
 * Bridgic Agent daemon readiness.
 *
 * Behaviour by `BackendState`:
 *   - `idle` / `discovering` / `spawning` / `unhealthy` → spinner card
 *   - `ready`                              → render `children` (pass-through)
 *   - `unavailable`                       → "gateway not running" card with [start gateway]
 *   - `incompatible`                      → version-mismatch card with [restart gateway]
 *
 * Why `incompatible` is its own blocking screen rather than a banner over the
 * normal UI: a mismatch means an update was applied to the app but the daemon
 * serving it is still the previous build. Every request the renderer makes from
 * that point crosses a contract neither side agreed on, so the failures would be
 * arbitrary and blamed on the feature the user happened to touch. Blocking is
 * the honest answer. The only way out is an explicit restart, because restarting
 * drops whatever the daemon is doing for other clients.
 *
 * `unhealthy` is a short fail-closed recovery state. PythonClient deliberately
 * retires the old endpoint before re-authenticating runtime.json, so allowing
 * business requests through here would recreate the misleading "no token"
 * errors this gate exists to prevent. Successful recovery returns to `ready`;
 * an exhausted recovery lands on `unavailable` with an explicit start action.
 *
 * M1 simplification: no "offline mode" branch from the vision doc —
 * without a daemon the agent surface is non-functional, so a
 * dedicated bypass would be misleading. Deferred to a later milestone.
 *
 * Mount-order contract: the parent (`App.tsx`) MUST call
 * `useBackendBridge()` BEFORE returning this component so the atom is
 * actually wired to receive state updates — otherwise this stays on
 * the default `idle` spinner forever.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { APP_PRODUCT_NAME } from '@shared/app-meta'
import type { BackendCompatibility } from '@shared/types'
import { backendCompatibilityAtom, backendErrorAtom, backendStateAtom } from '../../atoms/backend'
import { openIssueReportAtom } from '../../atoms/issue-report'
import { isHandingOverUpdateAtom } from '../../atoms/update'
import { rlog } from '../../lib/logger'
import { BackendState, CompatibilityState } from '../../../main/python-client/types'
import { Icons } from './Icons'
import { Btn, BridgicLogo, Card } from './Primitives'

export interface GatewayBootGateProps {
  children: ReactNode
}

export function GatewayBootGate({ children }: GatewayBootGateProps) {
  const { t } = useTranslation()
  const state = useAtomValue(backendStateAtom)
  const error = useAtomValue(backendErrorAtom)
  const compatibility = useAtomValue(backendCompatibilityAtom)
  const isHandingOver = useAtomValue(isHandingOverUpdateAtom)
  const [starting, setStarting] = useState(false)

  const booting =
    state === BackendState.Idle ||
    state === BackendState.Discovering ||
    state === BackendState.Spawning ||
    state === BackendState.Unhealthy

  const handleStart = useCallback(async () => {
    if (starting) return
    setStarting(true)
    try {
      await window.api.backend.start()
    } catch (err) {
      // PythonClient.start() is itself non-throwing (it transitions to
      // `unavailable` on failure), but the IPC layer might reject —
      // e.g. main process not yet ready. Surface to logs; the atom
      // subscription will land us back on `unavailable` shortly.
      rlog.error('[gateway-boot-gate] backend.start failed', err)
    } finally {
      setStarting(false)
    }
  }, [starting])

  if (state === BackendState.Ready) {
    return <>{children}</>
  }

  // Checked before every other non-ready branch: during a handover the gateway
  // is *supposed* to be down — we stopped it ourselves — so the usual
  // "not running, start it?" offer would invite the user to spawn a daemon the
  // installer is about to kill. Ranked above `Incompatible` too, since a
  // half-swapped bundle can report a mismatch mid-install.
  if (isHandingOver) {
    return (
      <BootGateLayout>
        <SpinnerHero label={t('gatewayBoot.installingUpdate')} />
      </BootGateLayout>
    )
  }

  if (state === BackendState.Incompatible) {
    return (
      <BootGateLayout>
        <VersionMismatchHero compatibility={compatibility} />
      </BootGateLayout>
    )
  }

  if (booting) {
    // The spinner is held back 400ms by `.boot-spinner-delayed` (index.css), so
    // the common case — daemon already up, adopted from runtime.json in a few
    // ms — shows only the plain background instead of a flash of connecting UI.
    const label = state === BackendState.Spawning ? t('gatewayBoot.starting') : t('gatewayBoot.connecting')
    return (
      <BootGateLayout>
        <div className="boot-spinner-delayed">
          <SpinnerHero label={label} />
        </div>
      </BootGateLayout>
    )
  }

  // state === BackendState.Unavailable
  return (
    <BootGateLayout>
      <NotRunningHero
        error={error}
        starting={starting}
        onStart={() => void handleStart()}
      />
    </BootGateLayout>
  )
}

/** `children` is optional so the pre-spinner delay can render the bare
 *  background (same layout, nothing in it) instead of a second variant. */
function BootGateLayout({ children }: { children?: ReactNode }) {
  return (
    <div
      className="relative w-screen h-screen flex items-center justify-center bg-bg-app"
      data-testid="gateway-boot-gate"
    >
      {/* A frameless window has no AppLayout title bar during the boot gate stage — add a strip of the same
          height at the top that is app-drag, otherwise there is nowhere to drag the whole window. The height follows the
          same variable as TopBar (on Windows that is the caption height the system actually draws), otherwise the boot-stage
          drag strip would be misaligned with the top bar that appears afterwards. */}
      <div className="app-drag absolute top-0 inset-x-0 h-[var(--titlebar-height)]" />
      {children}
    </div>
  )
}

function SpinnerHero({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-5">
      <BridgicLogo size={48} />
      <div className="flex items-center gap-3">
        <Spinner />
        <span className="text-sm text-text-secondary">{label}</span>
      </div>
    </div>
  )
}

function NotRunningHero({
  error,
  starting,
  onStart,
}: {
  error: string | null
  starting: boolean
  onStart: () => void
}) {
  const { t } = useTranslation()
  const reportError = error?.trim() || t('gatewayBoot.notRunning.title')
  return (
    <Card className="w-[440px] p-6 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <BridgicLogo size={32} />
        <div className="flex-1">
          <div className="text-lg font-semibold text-text-primary">{t('gatewayBoot.notRunning.title')}</div>
          <div className="text-sm text-text-secondary mt-1 leading-relaxed">
            {t('gatewayBoot.notRunning.description', { product: APP_PRODUCT_NAME })}{' '}
            <code className="font-mono text-xs bg-bg-hover px-1.5 py-0.5 rounded">
              amphi server start
            </code>
          </div>
        </div>
      </div>
      {error && (
        <div className="px-3 py-2 rounded-md bg-status-error-bg text-status-error text-xs leading-relaxed">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <GatewayReportButton error={reportError} />
        <Btn
          variant="primary"
          size="md"
          onClick={onStart}
          data-testid="boot-gate-start"
        >
          {starting ? t('gatewayBoot.starting') : (
            <>
              {Icons.play(14)} {t('gatewayBoot.start')}
            </>
          )}
        </Btn>
      </div>
    </Card>
  )
}

/**
 * Blocking screen for a GUI/daemon version mismatch.
 *
 * Three shapes: `incompatible` (both versions known), `unknown` (daemon predates
 * the version field), and `manifest-unavailable` — which is OUR install being
 * broken, not the daemon's. That last one deliberately does not offer "restart
 * the gateway": the gateway is fine, and the action cannot succeed.
 */
function VersionMismatchHero({ compatibility }: { compatibility: BackendCompatibility | null }) {
  const { t } = useTranslation()
  const [restarting, setRestarting] = useState(false)
  const [quitting, setQuitting] = useState(false)
  const [clientCount, setClientCount] = useState<number | null>(null)
  // Ref rather than the `restarting` state — two clicks in one React batch read
  // the same stale value and would fire two concurrent daemon restarts.
  const restartInFlight = useRef(false)

  // One-shot read of the daemon's client registry so the restart warning can say
  // how much is actually attached. Failure is fine — the copy falls back to the
  // vaguer wording rather than blocking the only escape route the user has.
  useEffect(() => {
    let cancelled = false
    void window.api.backend
      .getClients()
      .then((result) => {
        if (!cancelled && result.ok) setClientCount(result.clients.length)
      })
      .catch((err: unknown) => {
        rlog.warn('[gateway-boot-gate] client count unavailable', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleRestart = useCallback(async () => {
    if (restartInFlight.current) return
    restartInFlight.current = true
    setRestarting(true)
    try {
      await window.api.backend.resolveCompatibility()
    } catch (err) {
      // The main handler never rejects on a failed restart (PythonClient
      // transitions to `unavailable` instead), so this only fires if the IPC
      // layer itself broke. The button stays usable either way.
      rlog.error('[gateway-boot-gate] resolveCompatibility failed', err)
    } finally {
      restartInFlight.current = false
      setRestarting(false)
    }
  }, [])

  // `app.quit` routes through quitWithDaemon, which may put up a native "other
  // clients are connected" dialog — so the promise can stay pending for as long
  // as the user takes to answer, and Cancel resolves without quitting. Without
  // this the click looks ignored on a screen where it is the main affordance.
  const handleQuit = useCallback(async () => {
    setQuitting(true)
    try {
      await window.api.app.quit()
    } catch (err) {
      rlog.error('[gateway-boot-gate] quit failed', err)
    } finally {
      setQuitting(false)
    }
  }, [])

  const isManifestBroken =
    compatibility !== null && compatibility.state === CompatibilityState.ManifestUnavailable
  const isUnknown =
    !isManifestBroken &&
    (compatibility === null || compatibility.state === CompatibilityState.Unknown)
  const reportError = (() => {
    if (isManifestBroken) return t('gatewayBoot.manifestUnavailable.title')
    if (isUnknown) return t('gatewayBoot.unknownVersion.title')
    if (compatibility?.state === CompatibilityState.Incompatible) {
      return [
        t('gatewayBoot.incompatible.title'),
        `${t('gatewayBoot.incompatible.expected')}: ${compatibility.expected}`,
        `${t('gatewayBoot.incompatible.actual')}: ${compatibility.actual}`,
      ].join(' — ')
    }
    return t('gatewayBoot.incompatible.title')
  })()

  if (isManifestBroken) {
    return (
      <Card className="w-[520px] p-6 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <BridgicLogo size={32} />
          <div className="flex-1">
            <div className="text-lg font-semibold text-text-primary">
              {t('gatewayBoot.manifestUnavailable.title')}
            </div>
            <div className="text-sm text-text-secondary mt-1 leading-relaxed">
              {t('gatewayBoot.manifestUnavailable.description', { product: APP_PRODUCT_NAME })}
            </div>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <GatewayReportButton error={reportError} />
          <Btn variant="primary" size="md" onClick={() => void handleQuit()}>
            {quitting ? t('gatewayBoot.incompatible.exiting') : t('gatewayBoot.incompatible.exit')}
          </Btn>
        </div>
      </Card>
    )
  }

  return (
    <Card className="w-[520px] p-6 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <BridgicLogo size={32} />
        <div className="flex-1">
          <div className="text-lg font-semibold text-text-primary">
            {isUnknown
              ? t('gatewayBoot.unknownVersion.title')
              : t('gatewayBoot.incompatible.title')}
          </div>
          <div className="text-sm text-text-secondary mt-1 leading-relaxed">
            {isUnknown
              ? t('gatewayBoot.unknownVersion.description', { product: APP_PRODUCT_NAME })
              : t('gatewayBoot.incompatible.description', { product: APP_PRODUCT_NAME })}
          </div>
        </div>
      </div>

      <VersionRows compatibility={compatibility} />

      <div className="px-3 py-2 rounded-md bg-status-warning-bg text-status-warning text-xs leading-relaxed">
        {clientCount === null
          ? t('gatewayBoot.incompatible.clientsWarningUnknown')
          : t('gatewayBoot.incompatible.clientsWarning', { count: clientCount })}
      </div>

      <div className="flex gap-2 justify-end">
        <GatewayReportButton error={reportError} />
        <Btn variant="ghost" size="md" onClick={() => void handleQuit()}>
          {quitting ? t('gatewayBoot.incompatible.exiting') : t('gatewayBoot.incompatible.exit')}
        </Btn>
        <Btn
          variant="primary"
          size="md"
          onClick={() => void handleRestart()}
          data-testid="boot-gate-resolve-compatibility"
        >
          {restarting
            ? t('gatewayBoot.incompatible.restarting')
            : t('gatewayBoot.incompatible.restart')}
        </Btn>
      </div>
    </Card>
  )
}

function GatewayReportButton({ error }: { error: string }) {
  const { t } = useTranslation()
  const openIssueReport = useSetAtom(openIssueReportAtom)
  return (
    <Btn
      variant="ghost"
      size="md"
      onClick={() => openIssueReport({ source: 'gateway', error })}
      data-testid="boot-gate-report-issue"
    >
      {t('sidebar.feedback')}
    </Btn>
  )
}

/**
 * Expected-vs-running version read-out. Renders nothing when the daemon never
 * reported a version — an "actual: —" row is noise next to the copy that already
 * says the version is unknown.
 */
function VersionRows({ compatibility }: { compatibility: BackendCompatibility | null }) {
  const { t } = useTranslation()
  if (compatibility === null || compatibility.state !== CompatibilityState.Incompatible) {
    return null
  }
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-md bg-bg-hover">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">{t('gatewayBoot.incompatible.expected')}</span>
        <code className="font-mono text-text-primary">{compatibility.expected}</code>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">{t('gatewayBoot.incompatible.actual')}</span>
        <code className="font-mono text-status-error">{compatibility.actual}</code>
      </div>
    </div>
  )
}

/**
 * Minimal spinner — 4×4 ring with brand-blue top arc spinning via
 * Tailwind's built-in `animate-spin`. No new keyframes / CSS.
 */
function Spinner() {
  const { t } = useTranslation()
  return (
    <div
      className="w-4 h-4 rounded-full border-2 border-border-default border-t-brand-blue animate-spin"
      role="status"
      aria-label={t('gatewayBoot.loading')}
    />
  )
}
