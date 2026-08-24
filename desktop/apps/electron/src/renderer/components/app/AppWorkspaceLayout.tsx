/** Three-column workspace composition driven by the renderer's canonical view atoms. */
import type { ReactNode } from 'react'
import { useAtomValue } from 'jotai'
import { showRightPanelAtom } from '@/atoms/amphi'
import {
  browserExpandedAtom,
  SessionWorkbenchSurface,
  sessionWorkbenchSurfaceAtom,
} from '@/atoms/browser'
import { sessionFocusPaneOpenAtom } from '@/atoms/session-focus-pane-view'
import { presentationExpandedAtom } from '@/atoms/presentation'
import { AppLayout } from '@/components/amphi'

export interface AppWorkspaceLayoutProps {
  left: ReactNode
  center: ReactNode
  right: ReactNode
}

/**
 * Translate app state into AppLayout props in one place.
 *
 * In particular, `showRightPanelAtom` is the complete dock-visibility verdict;
 * this composition must not apply another conversation or draft gate.
 */
export function AppWorkspaceLayout({ left, center, right }: AppWorkspaceLayoutProps) {
  const showSessionDock = useAtomValue(showRightPanelAtom)
  const browserExpanded = useAtomValue(browserExpandedAtom)
  const presentationExpanded = useAtomValue(presentationExpandedAtom)
  const workbenchSurface = useAtomValue(sessionWorkbenchSurfaceAtom)
  const focusPaneOpen = useAtomValue(sessionFocusPaneOpenAtom)
  const browserLayout = !focusPaneOpen && workbenchSurface === SessionWorkbenchSurface.Browser
  const presentationLayout = !focusPaneOpen
    && workbenchSurface === SessionWorkbenchSurface.Presentation
  let rightKind: 'panel' | 'browser' | 'presentation' = 'panel'
  if (browserLayout) rightKind = 'browser'
  else if (presentationLayout) rightKind = 'presentation'

  return (
    <AppLayout
      titleBar={false}
      rightCollapsed={!showSessionDock}
      left={left}
      center={center}
      right={right}
      rightKind={rightKind}
      rightExpanded={(browserLayout && browserExpanded)
        || (presentationLayout && presentationExpanded)}
    />
  )
}
