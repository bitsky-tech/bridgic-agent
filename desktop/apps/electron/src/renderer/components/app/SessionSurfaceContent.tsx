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
import { SessionWorkbenchPanel } from './SessionWorkbenchPanel'
import { SpecPreviewPane } from './SpecPreviewPane'
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel'
import { WorkflowResultsPanel } from './WorkflowResultsPanel'
import { WorkflowRunDetailsPane } from './WorkflowRunDetailsPane'
import { cn } from '@/lib/cn'

export interface SessionSurfaceContentProps {
  isBrowserActive: boolean
  /** The workbench presenting the native surface, or null when none is. */
  activeWorkbench: 'sheet' | 'doc' | null
  isNativeHandoffPending: boolean
  isToolActive: (surface: SessionWorkbenchSurface) => boolean
  modeSurfaceKey: string
  /** The one panel allowed to confirm the native surface is hidden. */
  nativeHandoffOwner: 'browser' | 'sheet' | 'doc' | null
  nativeHideAcknowledgement: number
  onNativeHideFailed: () => void
  onNativeHidden: () => void
  selectedModeSurface: SessionModeSurfaceKind | null
}

/** Keep workbench tools mounted while presenting one tool or Agent mode surface. */
export function SessionSurfaceContent({
  activeWorkbench,
  isBrowserActive,
  isNativeHandoffPending,
  isToolActive,
  modeSurfaceKey,
  nativeHandoffOwner,
  nativeHideAcknowledgement,
  onNativeHideFailed,
  onNativeHidden,
  selectedModeSurface,
}: SessionSurfaceContentProps) {
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

      {(['sheet', 'doc'] as const).map((kind) => {
        const isActive = activeWorkbench === kind
        return (
          <div
            key={kind}
            id={`session-workbench-${kind}-content`}
            role="tabpanel"
            aria-hidden={!isActive}
            aria-labelledby={`session-workbench-${kind}-tab`}
            className={cn(
              'absolute inset-0 z-0',
              isActive ? 'visible' : 'invisible pointer-events-none',
            )}
            data-testid={`session-workbench-${kind}-content`}
          >
            <SessionWorkbenchPanel
              kind={kind}
              presentationVisible={isActive}
              onPresentationHidden={
                isNativeHandoffPending && nativeHandoffOwner === kind ? onNativeHidden : undefined
              }
              onPresentationHideFailed={
                isNativeHandoffPending && nativeHandoffOwner === kind
                  ? onNativeHideFailed
                  : undefined
              }
            />
          </div>
        )
      })}

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
          onPresentationHidden={
            isNativeHandoffPending && nativeHandoffOwner === 'browser' ? onNativeHidden : undefined
          }
          onPresentationHideFailed={
            isNativeHandoffPending && nativeHandoffOwner === 'browser'
              ? onNativeHideFailed
              : undefined
          }
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
