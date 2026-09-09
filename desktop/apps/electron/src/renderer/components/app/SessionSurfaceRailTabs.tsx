/** Permanent workbench tabs rendered below the Bridgic entry in the Session rail. */
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { SessionWorkbenchSurface } from '@/atoms/browser'
import { Icons } from '@/components/amphi/Icons'
import { OFFICE_APP_KINDS, type OfficeAppKind, type OfficeSurfaceStatuses } from '@/lib/office/officeSurfaceStatus'
import { OfficeSurfaceRailButton, type OfficeRailLabels } from './OfficeSurfaceRailButton'
import { SurfaceRailButton } from './SessionSurfaceChrome'

export interface SessionSurfaceRailTabsProps {
  browserAriaLabel: string
  browserLabel: string
  browserNeedsAttention: boolean
  filesNeedsAttention: boolean
  hasBrowserOpenPage: boolean
  isBrowserAgentActive: boolean
  isBrowserBusy: boolean
  isContentOpen: boolean
  isModeSelected: boolean
  onSelect: (surface: SessionWorkbenchSurface) => void
  officeStatuses: OfficeSurfaceStatuses
  seenOfficeSurface: OfficeAppKind | null
  selectedSurface: SessionWorkbenchSurface
}

/** Office entries share one status contract; other tools keep their own domain adapters. */
export function SessionSurfaceRailTabs({
  browserAriaLabel,
  browserLabel,
  browserNeedsAttention,
  filesNeedsAttention,
  hasBrowserOpenPage,
  isBrowserAgentActive,
  isBrowserBusy,
  isContentOpen,
  isModeSelected,
  onSelect,
  officeStatuses,
  seenOfficeSurface,
  selectedSurface,
}: SessionSurfaceRailTabsProps) {
  const { t } = useTranslation()
  const tools = [
    {
      ariaLabel: filesNeedsAttention
        ? t('session.resourcePanel.filesNeedsAttention')
        : t('session.resourcePanel.files'),
      icon: Icons.folder(17),
      isOpenInBackground: false,
      label: t('session.resourcePanel.files'),
      showActiveIndicator: true,
      surface: SessionWorkbenchSurface.Files,
      testId: 'session-workbench-files',
    },
    {
      ariaLabel: t('session.resourcePanel.workflows'),
      icon: Icons.workflow(17),
      isOpenInBackground: false,
      label: t('session.resourcePanel.workflows'),
      showActiveIndicator: true,
      surface: SessionWorkbenchSurface.Workflows,
      testId: 'session-workbench-workflows',
    },
    {
      ariaLabel: t('session.resourcePanel.results'),
      icon: Icons.workflowResult(17),
      isOpenInBackground: false,
      label: t('session.resourcePanel.results'),
      showActiveIndicator: true,
      surface: SessionWorkbenchSurface.Results,
      testId: 'session-workbench-results',
    },
    ...OFFICE_APP_KINDS.map((surface) => ({ surface, office: true as const })),
    {
      ariaLabel: browserAriaLabel,
      icon: Icons.globe(17),
      label: browserLabel,
      isOpenInBackground: hasBrowserOpenPage,
      showActiveIndicator: true,
      surface: SessionWorkbenchSurface.Browser,
      testId: 'session-workbench-browser',
    },
  ] as const

  return tools.map((tool) => {
    const isBrowser = tool.surface === SessionWorkbenchSurface.Browser
    const isFiles = tool.surface === SessionWorkbenchSurface.Files
    const isSelected = !isModeSelected && selectedSurface === tool.surface
    if ('office' in tool) {
      const status = officeStatuses[tool.surface]
      return (
        <OfficeSurfaceRailButton
          icon={officeDefinitions[tool.surface].icon}
          isActive={isContentOpen && isSelected}
          isSeen={seenOfficeSurface === tool.surface}
          isSelected={isSelected}
          key={`${status.sessionId}:${tool.surface}`}
          labels={officeDefinitions[tool.surface]}
          onClick={() => onSelect(tool.surface)}
          status={status}
        />
      )
    }
    return (
      <SurfaceRailButton
        isActive={isContentOpen && isSelected}
        ariaLabel={tool.ariaLabel}
        controls={`${tool.testId}-content`}
        icon={tool.icon}
        key={tool.surface}
        label={tool.label}
        isOpenInBackground={tool.isOpenInBackground ?? false}
        showActiveIndicator={tool.showActiveIndicator}
        isBusy={isBrowser && isBrowserBusy}
        isPulsing={isBrowser && isBrowserAgentActive && !browserNeedsAttention}
        needsAttention={(
          (isBrowser && browserNeedsAttention)
          || (isFiles && filesNeedsAttention)
        )}
        isSelected={isSelected}
        testId={tool.testId}
        onClick={() => onSelect(tool.surface)}
      />
    )
  })
}

const officeDefinitions: Readonly<Record<OfficeAppKind, OfficeRailLabels & { icon: ReactNode }>> = {
  presentation: {
    icon: Icons.presentation(17),
    title: 'session.resourcePanel.presentation',
    agentActive: 'session.resourcePanel.presentationAgentActive',
    activeShort: 'session.resourcePanel.presentationActiveShort',
    needsAttention: 'session.resourcePanel.presentationNeedsAttention',
    opened: 'session.resourcePanel.presentationOpened',
  },
  word: { icon: Icons.wordDocument(17), title: 'session.resourcePanel.word' },
  excel: { icon: Icons.spreadsheet(17), title: 'session.resourcePanel.excel' },
}
