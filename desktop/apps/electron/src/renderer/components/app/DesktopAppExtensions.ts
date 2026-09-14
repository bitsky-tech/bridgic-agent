import type { ComponentType, ReactNode } from 'react'
import type { SessionWorkbenchExtensionId } from '@/atoms/workbench'

export interface ConversationHistoryProps {
  sessionId: string
}

export interface SessionWorkbenchExtensionProps {
  sessionId: string
  active: boolean
  onClose: () => void
}

/** Renderer-only tools share the Session dock's selection and native hide handoff. */
export interface SessionWorkbenchExtension {
  id: SessionWorkbenchExtensionId
  label: string
  icon: ReactNode
  /** Agent tools appear below Bridgic, before the divider; other extensions follow built-in tools. */
  placement?: 'agent' | 'tools'
  Content: ComponentType<SessionWorkbenchExtensionProps>
}

/** Optional entry-point customization; the Desktop shell and composer stay shared. */
export interface DesktopAppExtensions {
  ConversationHistory?: ComponentType<ConversationHistoryProps>
  sessionSurfaces?: readonly SessionWorkbenchExtension[]
}

export const EMPTY_SESSION_EXTENSIONS: readonly SessionWorkbenchExtension[] = []

export function extensionSurfaceTestId(id: SessionWorkbenchExtensionId): string {
  return `session-workbench-${id}`
}
