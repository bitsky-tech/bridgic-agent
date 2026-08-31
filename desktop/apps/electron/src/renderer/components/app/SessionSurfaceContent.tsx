/** Renderer and native content stack behind the Session right-side rail. */
import { SessionWorkbenchSurface } from '@/atoms/browser'
import { SessionModeSurfaceKind } from '@/atoms/session-focus-pane-view'
import { EmbeddedBrowserPanel } from './EmbeddedBrowserPanel'
import { ScheduleWorkbenchPanel } from './ScheduleWorkbenchPanel'
import { SessionFilesPanel } from './SessionFilesPanel'
import {
  ModeSurfaceGate,
  WorkbenchSurface,
} from './SessionSurfaceChrome'
import { SpecPreviewPane } from './SpecPreviewPane'
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel'
import { WorkflowResultsPanel } from './WorkflowResultsPanel'
import { WorkflowRunDetailsPane } from './WorkflowRunDetailsPane'
import { ExcelWorkbenchPanel } from './ExcelWorkbenchPanel'
import { cn } from '@/lib/cn'

export interface SessionSurfaceContentProps {
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
  isBrowserActive,
  isNativeHandoffPending,
  isToolActive,
  modeSurfaceKey,
  nativeHideAcknowledgement,
  onNativeHideFailed,
  onNativeHidden,
  selectedModeSurface,
}: SessionSurfaceContentProps) {
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

      {selectedModeSurface !== null ? (
        <ModeSurfaceGate
          key={modeSurfaceKey}
          shouldAwaitNativeHide={isNativeHandoffPending}
          nativeHideAcknowledgement={nativeHideAcknowledgement}
        >
          {selectedModeSurface === SessionModeSurfaceKind.Task
            ? <SpecPreviewPane />
            : <WorkflowRunDetailsPane />}
        </ModeSurfaceGate>
      ) : null}
    </div>
  )
}
