/**
 * Left sidebar's gateway control strip — status dot · "Gateway" + version ·
 * restart · stop/start.
 *
 * Extracted from `LeftSidebar` so the row can be left out without leaving its
 * side effects behind — which is the whole reason this is a component and not
 * a fragment inline in the parent: it owns `useGatewayClientsRefresh`, and a
 * hook cannot be called conditionally, so inline in the parent the 60s
 * client-list poll would keep running against a row nobody can see.
 *
 * Currently NOT rendered (see the comment at its former call site in
 * `LeftSidebar`). Kept intact because restoring the row is a one-line change
 * and nothing here is stale.
 *
 * Invariants:
 *   - `busy` serializes the two buttons: whichever action is in flight disables
 *     the other, so a restart can't be interleaved with a stop.
 *   - Restart is stop-then-start, NOT `backend.restart()` — see the comment on
 *     `onRestart`.
 *
 * Non-obvious dep: reads `backendStateAtom` / `backendEndpointAtom`, which the
 * main process feeds through the PythonClient state bridge.
 */
import { useAtomValue } from 'jotai'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { backendEndpointAtom, backendStateAtom } from '@/atoms/backend'
import { useConnectedClients, useGatewayClientsRefresh } from '@/hooks/useConnectedClients'
import { BackendState } from '../../../main/python-client/types'
import { cn } from '@/lib/cn'
import { rlog } from '@/lib/logger'
import { Icons } from './Icons'
import { Tooltip } from './Tooltip'
import { SettingsTabId } from './Modals'

/** Tailwind bg-* class for the gateway status dot, by backend state buckets. */
function pickDotColor(isRunning: boolean, isError: boolean, isTransitioning: boolean): string {
  if (isRunning) return 'bg-status-success'
  if (isError) return 'bg-status-error'
  if (isTransitioning) return 'bg-status-warning'
  return 'bg-text-tertiary'
}

/** Human-readable label for the gateway status, by backend state. */
function pickStateLabel(t: TFunction, isRunning: boolean, backendState: BackendState): string {
  if (isRunning) return t('sidebar.gateway.status.running')
  if (backendState === BackendState.Discovering) return t('sidebar.gateway.status.discovering')
  if (backendState === BackendState.Spawning) return t('sidebar.gateway.status.starting')
  if (backendState === BackendState.Unhealthy) return t('sidebar.gateway.status.unhealthy')
  // Currently unreachable — GatewayBootGate blocks the whole tree on this state.
  // Kept so that whoever makes the gate non-blocking does not silently inherit
  // "stopped" for a gateway that is demonstrably running.
  if (backendState === BackendState.Incompatible) return t('sidebar.gateway.status.incompatible')
  if (backendState === BackendState.Unavailable) return t('sidebar.gateway.status.unavailable')
  return t('sidebar.gateway.status.stopped')
}

export interface GatewayRowProps {
  /** Opens the settings modal on the given tab; the label area routes to Gateway. */
  onOpenSettings?: (initialTab?: SettingsTabId) => void
}

export function GatewayRow({ onOpenSettings }: GatewayRowProps) {
  const { t } = useTranslation()
  const backendState = useAtomValue(backendStateAtom)
  const backendEndpoint = useAtomValue(backendEndpointAtom)
  // M1/T30 — surface 'N clients online' in the gateway tooltip. We refresh
  // every 60s (cheap: localhost IPC + small JSON) so a CLI / tray
  // connecting in the background reflects in the tip within a minute
  // without the user opening Settings. The Settings → Gateway panel
  // mounts its own faster (5s) refresh while open, dedup'd by the
  // loading guard in refreshConnectedClientsAtom.
  const { count: clientsCount, clients: clientsList } = useConnectedClients()
  useGatewayClientsRefresh(60_000)
  const [busy, setBusy] = useState<'restart' | 'stop' | 'start' | null>(null)

  const isRunning = backendState === BackendState.Ready
  const isError =
    backendState === BackendState.Unhealthy ||
    backendState === BackendState.Unavailable ||
    backendState === BackendState.Incompatible
  const isTransitioning =
    backendState === BackendState.Discovering || backendState === BackendState.Spawning
  const dotColor = pickDotColor(isRunning, isError, isTransitioning)
  const stateLabel = pickStateLabel(t, isRunning, backendState)
  // Show client count only when daemon is ready AND atom is populated
  // (clientsList !== null means at least one successful fetch).
  // Otherwise the count would be a stale or never-fetched 0 — misleading.
  const shouldShowCount = isRunning && clientsList !== null
  const clientsSegment = shouldShowCount ? t('sidebar.gateway.clientsOnline', { n: clientsCount }) : ''
  const gatewayTitle =
    isRunning && backendEndpoint
      ? t('sidebar.gateway.tooltipWithEndpoint', { status: stateLabel, endpoint: backendEndpoint.baseUrl, clients: clientsSegment })
      : t('sidebar.gateway.tooltip', { status: stateLabel })
  const version = backendEndpoint?.version ?? null

  const handleOpenGatewaySettings = () => {
    onOpenSettings?.(SettingsTabId.Gateway)
  }

  const runBackendAction = async (
    action: 'restart' | 'stop' | 'start',
    fn: () => Promise<void>,
  ) => {
    if (busy) return
    setBusy(action)
    try {
      await fn()
    } catch (err) {
      rlog.error(`[gateway] ${action} failed`, err)
    } finally {
      setBusy(null)
    }
  }
  const onRestart = () =>
    runBackendAction('restart', async () => {
      // Sequence stop → start through the proven IPC paths instead of
      // backend.restart(). PythonClient.restart() doesn't tear down the
      // health timer + endpoint before re-spawning, so an in-flight
      // /health probe can race the spawn and double-call cliStart
      // (port collision → daemon fails to come up). stop()+start() goes
      // through stopDaemon (clears timer + endpoint, state=Unavailable)
      // before start() spawns a fresh one — same paths the Settings
      // panel uses, well-exercised.
      if (isRunning) {
        await window.api.backend.stop()
      }
      await window.api.backend.start()
    })
  const onStopOrStart = () =>
    isRunning
      ? runBackendAction('stop', () => window.api.backend.stop())
      : runBackendAction('start', () => window.api.backend.start())

  return (
    /* The hover hint summarizing daemon status/endpoint goes through the shared
       Tooltip primitive (attached to the name area; the buttons have their own
       action hints). */
    <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-subtle">
      <span
        data-testid="gateway-status-dot"
        className={cn(
          'w-1.5 h-1.5 rounded-full flex-shrink-0',
          dotColor,
          isTransitioning && 'animate-pulse',
        )}
      />
      <Tooltip content={gatewayTitle}>
        <div
          data-testid="open-settings"
          onClick={handleOpenGatewaySettings}
          className="flex-1 min-w-0 flex items-baseline gap-1.5 cursor-pointer"
        >
          <span className="text-sm font-medium text-text-primary truncate">Gateway</span>
          {version && (
            <span className="text-xs font-mono text-text-tertiary truncate">{version}</span>
          )}
        </div>
      </Tooltip>
      <div className="flex items-center gap-0.5 text-text-tertiary flex-shrink-0">
        <Tooltip content={isRunning ? t('sidebar.gateway.restart') : t('sidebar.gateway.start')}>
          <div
            data-testid="gateway-restart"
            onClick={busy ? undefined : onRestart}
            className={cn(
              'p-1.5 rounded cursor-pointer hover:bg-bg-hover hover:text-text-primary',
              busy === 'restart' && 'animate-spin opacity-60',
              busy && busy !== 'restart' && 'opacity-40 cursor-not-allowed',
            )}
          >
            {Icons.restart(14)}
          </div>
        </Tooltip>
        <Tooltip content={isRunning ? t('sidebar.gateway.stop') : t('sidebar.gateway.start')}>
          <div
            data-testid="gateway-stop-or-start"
            onClick={busy ? undefined : onStopOrStart}
            className={cn(
              'p-1.5 rounded cursor-pointer hover:bg-bg-hover hover:text-text-primary',
              busy && busy !== 'restart' && 'opacity-60',
              busy === 'restart' && 'opacity-40 cursor-not-allowed',
            )}
          >
            {isRunning ? Icons.square(14) : Icons.play(14)}
          </div>
        </Tooltip>
      </div>
    </div>
  )
}
