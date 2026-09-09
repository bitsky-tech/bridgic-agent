import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSurfaceActivityPresentation } from '@/hooks/useSurfaceActivityPresentation'
import { hasOfficeBackgroundContent, type OfficeSurfaceStatus } from '@/lib/office/officeSurfaceStatus'
import { SurfaceRailButton } from './SessionSurfaceChrome'

export interface OfficeRailLabels {
  title: string
  agentActive?: string
  activeShort?: string
  needsAttention?: string
  opened?: string
}

/** All Office entries interpret presence, selection, attention and Agent activity identically. */
export function OfficeSurfaceRailButton({ icon, isActive, isSeen, isSelected, labels, onClick, status }: {
  icon: ReactNode
  isActive: boolean
  isSeen: boolean
  isSelected: boolean
  labels: OfficeRailLabels
  onClick: () => void
  status: OfficeSurfaceStatus
}) {
  const { t } = useTranslation()
  const agentActive = status.agentActivity === 'active'
  const activity = useSurfaceActivityPresentation(agentActive ? 'agent' : null)
  const hasContent = hasOfficeBackgroundContent(status)
  const needsAttention = status.needsAttention === true && !isSeen
  const busy = activity !== null
  const testId = `session-workbench-${status.appKind}`
  let ariaLabel = labels.title
  if (busy) ariaLabel = labels.agentActive ?? labels.title
  else if (needsAttention) ariaLabel = labels.needsAttention ?? labels.title
  else if (hasContent) ariaLabel = labels.opened ?? labels.title

  return (
    <SurfaceRailButton
      ariaLabel={t(ariaLabel)}
      controls={`${testId}-content`}
      icon={icon}
      isActive={isActive}
      isBusy={busy}
      isOpenInBackground={hasContent}
      isPulsing={agentActive && busy && !needsAttention}
      isSelected={isSelected}
      label={t(busy ? labels.activeShort ?? labels.title : labels.title)}
      needsAttention={needsAttention}
      onClick={onClick}
      showActiveIndicator={hasContent}
      testId={testId}
    />
  )
}
