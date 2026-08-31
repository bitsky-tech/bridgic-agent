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
  hasPresentationOpen: boolean
  isBrowserAgentActive: boolean
  isBrowserBusy: boolean
  isPowerPointAgentActive: boolean
  isPowerPointBusy: boolean
  isContentOpen: boolean
  isModeSelected: boolean
  onSelect: (surface: SessionWorkbenchSurface) => void
  powerPointAriaLabel: string
  powerPointLabel: string
  powerPointNeedsAttention: boolean
  selectedSurface: SessionWorkbenchSurface
}

/** Render the five independent Session tools with a Browser-specific activity state. */
export function SessionSurfaceRailTabs({
  browserAriaLabel,
  browserLabel,
  browserNeedsAttention,
  filesNeedsAttention,
  hasBrowserOpenPage,
  hasPresentationOpen,
  isBrowserAgentActive,
  isBrowserBusy,
  isPowerPointAgentActive,
  isPowerPointBusy,
  isContentOpen,
  isModeSelected,
  onSelect,
  powerPointAriaLabel,
  powerPointLabel,
  powerPointNeedsAttention,
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
    {
      ariaLabel: powerPointAriaLabel,
      icon: Icons.presentation(17),
      isOpenInBackground: hasPresentationOpen,
      label: powerPointLabel,
      showActiveIndicator: hasPresentationOpen,
      surface: SessionWorkbenchSurface.Presentation,
      testId: 'session-workbench-presentation',
    },
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
    const isPowerPoint = tool.surface === SessionWorkbenchSurface.Presentation
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
        showActiveIndicator={tool.showActiveIndicator}
        isBusy={(isBrowser && isBrowserBusy) || (isPowerPoint && isPowerPointBusy)}
        isPulsing={(
          (isBrowser && isBrowserAgentActive && !browserNeedsAttention)
          || (isPowerPoint && isPowerPointAgentActive && !powerPointNeedsAttention)
        )}
        needsAttention={(
          (isBrowser && browserNeedsAttention)
          || (isFiles && filesNeedsAttention)
          || (isPowerPoint && powerPointNeedsAttention)
        )}
        isSelected={isSelected}
        testId={tool.testId}
        onClick={() => onSelect(tool.surface)}
      />
    )
  })
}
