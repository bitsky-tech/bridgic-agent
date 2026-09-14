/** Renderer and native content stack behind the Session right-side rail. */
import { SessionWorkbenchSurface } from '@/atoms/browser'
import { SessionModeSurfaceKind } from '@/atoms/session-focus-pane-view'
import { EmbeddedBrowserPanel } from './EmbeddedBrowserPanel'
import { EmbeddedPowerPointPanel } from './EmbeddedPowerPointPanel'
import { ScheduleWorkbenchPanel } from './ScheduleWorkbenchPanel'
import { SessionFilesPanel } from './SessionFilesPanel'
import {
  ModeSurfaceGate,
  WorkbenchSurface,
} from './SessionSurfaceChrome'
import { SpecPreviewPane } from './SpecPreviewPane'
import { PresentationModePane } from './PresentationModePane'
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel'
import { WorkflowResultsPanel } from './WorkflowResultsPanel'
import { WorkflowRunDetailsPane } from './WorkflowRunDetailsPane'
import { WordWorkbenchPanel } from './WordWorkbenchPanel'
import { ExcelWorkbenchPanel } from './ExcelWorkbenchPanel'
import { cn } from '@/lib/cn'
import { EMPTY_SESSION_EXTENSIONS, extensionSurfaceTestId, type SessionWorkbenchExtension } from './DesktopAppExtensions'

export interface SessionSurfaceContentProps {
  extensions?: readonly SessionWorkbenchExtension[]
  sessionId?: string | null
  onCloseExtension?: (surface: SessionWorkbenchExtension['id']) => void
  isBrowserActive: boolean
  isNativeHandoffPending: boolean
  isToolActive: (surface: SessionWorkbenchSurface) => boolean
  modeSurfaceKey: string
  nativeHideAcknowledgement: number
  onNativeHideFailed: () => void
  onNativeHidden: () => void
  selectedModeSurface: SessionModeSurfaceKind | null
}

/** Keep workbench tools mounted while presenting one tool or Agent mode surface. */
export function SessionSurfaceContent({
  extensions = EMPTY_SESSION_EXTENSIONS,
  sessionId,
  onCloseExtension,
  isBrowserActive,
  isNativeHandoffPending,
  isToolActive,
  modeSurfaceKey,
  nativeHideAcknowledgement,
  onNativeHideFailed,
  onNativeHidden,
  selectedModeSurface,
}: SessionSurfaceContentProps) {
  let modeContent = <WorkflowRunDetailsPane />
  if (selectedModeSurface === SessionModeSurfaceKind.Task) {
    modeContent = <SpecPreviewPane />
  } else if (selectedModeSurface === SessionModeSurfaceKind.Presentation) {
    modeContent = <PresentationModePane />
  }
  const excelActive = isToolActive(SessionWorkbenchSurface.Excel)

  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      <WorkbenchSurface
        isActive={isToolActive(SessionWorkbenchSurface.Files)}
        labelledBy="session-workbench-files-tab"
        testId="session-workbench-files-content"
      >
        <SessionFilesPanel />
      </WorkbenchSurface>
      <WorkbenchSurface
        isActive={isToolActive(SessionWorkbenchSurface.Workflows)}
        labelledBy="session-workbench-workflows-tab"
        testId="session-workbench-workflows-content"
      >
        <WorkflowLibraryPanel active={isToolActive(SessionWorkbenchSurface.Workflows)} />
      </WorkbenchSurface>
      <WorkbenchSurface
        isActive={isToolActive(SessionWorkbenchSurface.Results)}
        labelledBy="session-workbench-results-tab"
        testId="session-workbench-results-content"
      >
        <WorkflowResultsPanel active={isToolActive(SessionWorkbenchSurface.Results)} />
      </WorkbenchSurface>
      <WorkbenchSurface
        isActive={isToolActive(SessionWorkbenchSurface.Schedules)}
        labelledBy="session-workbench-schedules-tab"
        testId="session-workbench-schedules-content"
      >
        <ScheduleWorkbenchPanel active={isToolActive(SessionWorkbenchSurface.Schedules)} />
      </WorkbenchSurface>
      <WorkbenchSurface
        isActive={isToolActive(SessionWorkbenchSurface.Presentation)}
        labelledBy="session-workbench-presentation-tab"
        testId="session-workbench-presentation-content"
      >
        <EmbeddedPowerPointPanel active={isToolActive(SessionWorkbenchSurface.Presentation)} />
      </WorkbenchSurface>
      <WorkbenchSurface
        isActive={isToolActive(SessionWorkbenchSurface.Word)}
        labelledBy="session-workbench-word-tab"
        testId="session-workbench-word-content"
      >
        <WordWorkbenchPanel active={isToolActive(SessionWorkbenchSurface.Word)} />
      </WorkbenchSurface>
      <WorkbenchSurface
        isActive={excelActive}
        labelledBy="session-workbench-excel-tab"
        testId="session-workbench-excel-content"
      >
        <ExcelWorkbenchPanel active={excelActive} />
      </WorkbenchSurface>

      <div
        id="session-workbench-browser-content"
        role="tabpanel"
        aria-hidden={!isBrowserActive}
        aria-labelledby="session-workbench-browser-tab"
        className={cn(
          'absolute inset-0 z-0',
          isBrowserActive ? 'visible' : 'invisible pointer-events-none',
        )}
        data-testid="session-workbench-browser-content"
      >
        <EmbeddedBrowserPanel
          presentationVisible={isBrowserActive}
          onPresentationHidden={isNativeHandoffPending ? onNativeHidden : undefined}
          onPresentationHideFailed={isNativeHandoffPending ? onNativeHideFailed : undefined}
        />
      </div>

      {sessionId ? extensions.map(({ id, Content }) => {
        const active = isToolActive(id)
        const testId = extensionSurfaceTestId(id)
        return (
          <WorkbenchSurface
            key={id}
            isActive={active}
            labelledBy={`${testId}-tab`}
            testId={`${testId}-content`}
          >
            <Content sessionId={sessionId} active={active} onClose={() => onCloseExtension?.(id)} />
          </WorkbenchSurface>
        )
      }) : null}

      {selectedModeSurface !== null ? (
        <ModeSurfaceGate
          key={modeSurfaceKey}
          shouldAwaitNativeHide={isNativeHandoffPending}
          nativeHideAcknowledgement={nativeHideAcknowledgement}
        >
          {modeContent}
        </ModeSurfaceGate>
      ) : null}
    </div>
  )
}
