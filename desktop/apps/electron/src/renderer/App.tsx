/**
 * App root component — does exactly two things: mount the global effect hooks
 * and compose the three-column layout.
 *
 * All view logic is delegated downward:
 *   - center column routing  → components/app/CenterView.tsx
 *   - left column wiring     → components/app/SidebarContainer.tsx
 *   - right column (session resources) → components/app/SessionResourcePanel.tsx
 *   - modal routing          → components/app/ActiveModalHost.tsx
 *   - view-decision derivation → atoms (showRightPanelAtom)
 *
 * Invariant: the effect hooks MUST mount before GatewayBootGate — by the time
 * the gate first reads backendStateAtom, useBackendBridge is already wired up.
 */
import { useBackendBridge } from './hooks/useBackendBridge'
import { useSettingsBridge } from './hooks/useSettingsBridge'
import { useApplyTheme } from './hooks/useTheme'
import { useApplyLocale } from './hooks/useLocale'
import { useWindowControlsInset } from './hooks/useWindowControlsInset'
import { useWindowFullScreenMarker } from './hooks/useWindowFullScreenMarker'
import { useSessionBootstrap } from './hooks/useSessionBootstrap'
import { useActiveSessionPersistence } from './hooks/useActiveSessionPersistence'
import { useActiveSessionReadReceipt } from './hooks/useActiveSessionReadReceipt'
import { useDraftPersistence } from './hooks/useDraftPersistence'
import { useLazyMessages } from './hooks/useLazyMessages'
import { useModelsHydration } from './hooks/useModelsHydration'
import { useScheduleHydration } from './hooks/useScheduleHydration'
import { useMainProcessEvents } from './hooks/useMainProcessEvents'
import { useDeepLinkNavigation } from './hooks/useDeepLinkNavigation'
import { useFsWatchBridge } from './hooks/useFsWatchBridge'
import { useWsConnection } from './hooks/useWsConnection'
import { useSpecCommentPersistence } from './hooks/useSpecCommentPersistence'
import { useAutoOpenTaskReview } from './hooks/useAutoOpenTaskReview'
import { useAutoOpenWorkflowRunDetails } from './hooks/useAutoOpenWorkflowRunDetails'
import { useCollapseNewSessionWorkbench } from './hooks/useCollapseNewSessionWorkbench'
import { useRememberRightPanelState } from './hooks/useRememberRightPanelState'
import { useEmbeddedBrowserBridge } from './hooks/useEmbeddedBrowserBridge'
import {
  ConfirmDialog,
  ExternalLinkDialog,
  GatewayBootGate,
  ImageLightbox,
  ReportIssueDialog,
  ToastHost,
} from './components/amphi'
import { ScheduleOverlays } from './components/schedules'
import { ActiveModalHost } from './components/app/ActiveModalHost'
import { AutoUpdateBanner } from './components/app/AutoUpdateBanner'
import { CenterView } from './components/app/CenterView'
import {
  BrowserAttentionAnnouncer,
  FilesAttentionAnnouncer,
  SessionResourcePanel,
} from './components/app/SessionResourcePanel'
import { SidebarContainer } from './components/app/SidebarContainer'
import { AppWorkspaceLayout } from './components/app/AppWorkspaceLayout'

export default function App() {
  // Cross-cutting bridges + first-mount lifecycle. All side-effecting; each
  // hook owns its own atoms + effect (see hooks/use-*.ts). App stays a pure
  // view orchestrator below.
  useSettingsBridge()
  useApplyTheme()
  useApplyLocale()
  useWindowControlsInset()
  useWindowFullScreenMarker()
  useBackendBridge()
  useSessionBootstrap()
  useActiveSessionPersistence()
  useActiveSessionReadReceipt()
  useDraftPersistence()
  useLazyMessages()
  useModelsHydration()
  useScheduleHydration()
  useMainProcessEvents()
  useDeepLinkNavigation()
  useFsWatchBridge()
  useWsConnection()
  useSpecCommentPersistence()
  useAutoOpenTaskReview()
  useAutoOpenWorkflowRunDetails()
  // Must run before the new-Session collapse effect: first snapshot the
  // destination Session's inherited state, then apply its rail-only default.
  useRememberRightPanelState()
  useCollapseNewSessionWorkbench()
  useEmbeddedBrowserBridge()

  // GatewayBootGate gates the entire UI on Bridgic Agent daemon readiness.
  // Wrapping includes the modal stack: any modal opened mid-session would
  // be unreachable once the daemon disappears anyway, and showing it
  // floating over the "gateway not running" card would be confusing.
  return (
    <>
      <BrowserAttentionAnnouncer />
      <FilesAttentionAnnouncer />
      <GatewayBootGate>
        <AppWorkspaceLayout
          left={<SidebarContainer />}
          center={<CenterView />}
          right={<SessionResourcePanel />}
        />
        <ActiveModalHost />
        <ScheduleOverlays />
        <ConfirmDialog />
        <ExternalLinkDialog />
        <ImageLightbox />
        <ToastHost />
      </GatewayBootGate>
      <ReportIssueDialog />
      {/* Outside the gate: an available update is exactly what the user needs to
          see when the gateway is down or version-blocked, and the gate hides
          everything it wraps. */}
      <AutoUpdateBanner />
    </>
  )
}
