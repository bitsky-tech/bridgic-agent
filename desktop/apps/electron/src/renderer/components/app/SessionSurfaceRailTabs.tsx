/** Permanent workbench tabs rendered below the Bridgic entry in the Session rail. */
import { useTranslation } from 'react-i18next'
import { SessionWorkbenchSurface } from '@/atoms/browser'
import { Icons } from '@/components/amphi/Icons'
import { SurfaceRailButton } from './SessionSurfaceChrome'

export interface SessionSurfaceRailTabsProps {
  browserAriaLabel: string
  browserLabel: string
  browserNeedsAttention: boolean
  filesNeedsAttention: boolean
  hasBrowserOpenPage: boolean
  hasExcelWorkbook: boolean
  isBrowserAgentActive: boolean
  isBrowserBusy: boolean
  isContentOpen: boolean
  isModeSelected: boolean
  onSelect: (surface: SessionWorkbenchSurface) => void
  selectedSurface: SessionWorkbenchSurface
}

/** Render the independent Session tools with a Browser-specific activity state. */
export function SessionSurfaceRailTabs({
  browserAriaLabel,
  browserLabel,
  browserNeedsAttention,
  filesNeedsAttention,
  hasBrowserOpenPage,
  hasExcelWorkbook,
  isBrowserAgentActive,
  isBrowserBusy,
  isContentOpen,
  isModeSelected,
  onSelect,
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
      surface: SessionWorkbenchSurface.Files,
      testId: 'session-workbench-files',
    },
    {
      ariaLabel: t('session.resourcePanel.workflows'),
      icon: Icons.workflow(17),
      isOpenInBackground: false,
      label: t('session.resourcePanel.workflows'),
      surface: SessionWorkbenchSurface.Workflows,
      testId: 'session-workbench-workflows',
    },
    {
      ariaLabel: t('session.resourcePanel.results'),
      icon: Icons.workflowResult(17),
      isOpenInBackground: false,
      label: t('session.resourcePanel.results'),
      surface: SessionWorkbenchSurface.Results,
      testId: 'session-workbench-results',
    },
    {
      ariaLabel: t('session.resourcePanel.excel'),
      icon: Icons.spreadsheet(17),
      isOpenInBackground: hasExcelWorkbook,
      label: t('session.resourcePanel.excel'),
      surface: SessionWorkbenchSurface.Excel,
      testId: 'session-workbench-excel',
    },
    {
      ariaLabel: browserAriaLabel,
      icon: Icons.globe(17),
      label: browserLabel,
      isOpenInBackground: hasBrowserOpenPage,
      surface: SessionWorkbenchSurface.Browser,
      testId: 'session-workbench-browser',
    },
  ] as const

  return tools.map((tool) => {
    const isBrowser = tool.surface === SessionWorkbenchSurface.Browser
    const isExcel = tool.surface === SessionWorkbenchSurface.Excel
    const isFiles = tool.surface === SessionWorkbenchSurface.Files
    const isSelected = !isModeSelected && selectedSurface === tool.surface
    return (
      <SurfaceRailButton
        isActive={isContentOpen && isSelected}
        ariaLabel={tool.ariaLabel}
        controls={`${tool.testId}-content`}
        icon={tool.icon}
        key={tool.surface}
        label={tool.label}
        isOpenInBackground={tool.isOpenInBackground ?? false}
        showActiveIndicator={!isExcel || hasExcelWorkbook}
        isBusy={isBrowser && isBrowserBusy}
        isPulsing={isBrowser && isBrowserAgentActive && !browserNeedsAttention}
        needsAttention={(isBrowser && browserNeedsAttention) || (isFiles && filesNeedsAttention)}
        isSelected={isSelected}
        testId={tool.testId}
        onClick={() => onSelect(tool.surface)}
      />
    )
  })
}
