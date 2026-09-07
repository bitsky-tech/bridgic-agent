import type { ReactNode } from 'react'
import { Maximize2, Minimize2, Plus, X } from 'lucide-react'
import { Tooltip } from '@/components/amphi/Tooltip'
import { cn } from '@/lib/cn'

/** Match the PowerPoint application header while keeping each editor's lifecycle local. */
export function OfficeAppHeader({ children, icon, iconClassName, subtitle, testId, title }: {
  children?: ReactNode
  icon: ReactNode
  iconClassName: string
  subtitle?: string
  testId?: string
  title: string
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border-subtle/70 bg-bg-surface/95 px-3" data-testid={testId}>
      <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', iconClassName)}>{icon}</div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-semibold text-text-primary">{title}</div>
        {subtitle ? <div className="mt-0.5 truncate text-[10px] text-text-tertiary">{subtitle}</div> : null}
      </div>
      {children}
    </header>
  )
}

export function OfficePanelControls({ closeLabel, expanded, expandLabel, onClose, onToggleExpanded, testIdPrefix, toggleTestId }: {
  closeLabel: string
  expanded: boolean
  expandLabel: string
  onClose?: () => void
  onToggleExpanded?: () => void
  testIdPrefix: string
  toggleTestId?: string
}) {
  return (
    <>
      {onToggleExpanded ? (
        <Tooltip content={expandLabel} placement="bottom">
          <button
            aria-label={expandLabel}
            aria-pressed={expanded}
            className={cn('flex size-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary', expanded && 'bg-brand-purple/10 text-brand-purple')}
            data-testid={toggleTestId ?? `${testIdPrefix}-toggle-expanded`}
            onClick={onToggleExpanded}
            type="button"
          >
            {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        </Tooltip>
      ) : null}
      {onClose ? (
        <Tooltip content={closeLabel} placement="bottom">
          <button
            aria-label={closeLabel}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            data-testid={`${testIdPrefix}-close-panel`}
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </Tooltip>
      ) : null}
    </>
  )
}

interface OfficeDocumentTab {
  closeLabel: string
  dirtyLabel?: string
  id: string
  label: string
}

export function OfficeDocumentTabs({ actions, activeId, icon, label, newDisabled, newLabel, onClose, onCreate, onSelect, tabs, testIdPrefix }: {
  actions?: ReactNode
  activeId: string | null
  icon: ReactNode
  label: string
  newDisabled?: boolean
  newLabel: string
  onClose: (id: string) => void
  onCreate: () => void
  onSelect: (id: string) => void
  tabs: OfficeDocumentTab[]
  testIdPrefix: string
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle/70 bg-bg-app px-2" data-testid={`${testIdPrefix}-document-header`}>
      <div aria-label={label} className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid={`${testIdPrefix}-document-tabs`} role="tablist">
        {tabs.map((tab) => (
          <div
            className={cn('group flex h-8 min-w-[132px] max-w-[240px] shrink-0 items-center rounded-lg border px-1 text-text-primary', tab.id === activeId ? 'border-border-subtle bg-bg-surface shadow-sm' : 'border-transparent bg-transparent hover:bg-bg-hover')}
            key={tab.id}
          >
            <Tooltip content={tab.label} placement="bottom">
              <button
                aria-selected={tab.id === activeId}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-1 text-left text-xs font-medium"
                data-testid={`${testIdPrefix}-document-tab`}
                onClick={() => onSelect(tab.id)}
                role="tab"
                type="button"
              >
                {icon}
                <span className="truncate">{tab.label}</span>
                {tab.dirtyLabel ? <span aria-label={tab.dirtyLabel} className="size-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
              </button>
            </Tooltip>
            <Tooltip content={tab.closeLabel} placement="bottom">
              <button
                aria-label={tab.closeLabel}
                className="flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary opacity-65 hover:bg-bg-hover hover:text-text-primary hover:opacity-100"
                data-testid={`${testIdPrefix}-close-document`}
                onClick={() => onClose(tab.id)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </Tooltip>
          </div>
        ))}
        <Tooltip content={newLabel} placement="bottom">
          <button
            aria-label={newLabel}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
            data-testid={`${testIdPrefix}-new-document`}
            disabled={newDisabled}
            onClick={onCreate}
            type="button"
          >
            <Plus className="size-4" />
          </button>
        </Tooltip>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  )
}
