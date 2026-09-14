import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icons } from '@/components/amphi/Icons'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

export interface WorkbenchToolSurfaceProps {
  children: ReactNode
  className?: string
  testId?: string
}

export function WorkbenchExpandIcon({ expanded, size = 15 }: {
  expanded: boolean
  size?: number
}) {
  return expanded ? (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5L2.5 2.5M9.5 9.5l4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 6.5v-4h4M13.5 9.5v4h-4M6.5 2.5l-4 4M9.5 13.5l4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Common viewport shell only. Each workbench tool still owns its data and interaction state. */
export function WorkbenchToolSurface({
  children,
  className,
  testId,
}: WorkbenchToolSurfaceProps) {
  return (
    <section
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg-surface animate-fade',
        className,
      )}
      data-testid={testId}
    >
      {children}
    </section>
  )
}

export interface WorkbenchToolHeaderProps {
  actions?: ReactNode
  icon: ReactNode
  iconClassName?: string
  testId?: string
  title: string
}

/** Neutral tool header; entity colour is confined to the icon. */
export function WorkbenchToolHeader({
  actions,
  icon,
  iconClassName,
  testId,
  title,
}: WorkbenchToolHeaderProps) {
  return (
    <header
      className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-surface px-4"
      data-testid={testId}
      style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
    >
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-hover text-text-secondary',
          iconClassName,
        )}
      >
        {icon}
      </span>
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
        {title}
      </h2>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  )
}

export interface WorkbenchSearchFieldProps {
  ariaLabel?: string
  clearLabel: string
  onQueryChange: (query: string) => void
  query: string
  searchPlaceholder: string
  testId?: string
}

export function WorkbenchSearchField({
  ariaLabel,
  clearLabel,
  onQueryChange,
  query,
  searchPlaceholder,
  testId,
}: WorkbenchSearchFieldProps) {
  const trimmed = query.trim()
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 rounded-md border border-border-subtle bg-bg-input px-2.5 py-1.5"
      data-testid={testId}
    >
      <span className="shrink-0 text-text-tertiary">{Icons.search(13)}</span>
      <input
        aria-label={ariaLabel ?? searchPlaceholder}
        className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-tertiary"
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={searchPlaceholder}
        value={query}
      />
      {trimmed ? (
        <button
          aria-label={clearLabel}
          className="flex shrink-0 items-center text-text-tertiary hover:text-text-primary"
          onClick={() => onQueryChange('')}
          type="button"
        >
          {Icons.x(12)}
        </button>
      ) : null}
    </div>
  )
}

export interface WorkbenchScopeOption<T extends string> {
  count?: number
  label: string
  value: T
}

export interface WorkbenchScopeButtonsProps<T extends string> {
  ariaLabel: string
  onChange: (value: T) => void
  options: readonly WorkbenchScopeOption<T>[]
  value: T
}

export function WorkbenchScopeButtons<T extends string>({
  ariaLabel,
  onChange,
  options,
  value,
}: WorkbenchScopeButtonsProps<T>) {
  return (
    <div aria-label={ariaLabel} className="flex flex-wrap gap-1.5" role="tablist">
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            aria-selected={selected}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              selected
                ? 'border-transparent bg-text-primary text-text-inverse'
                : 'border-border-subtle bg-bg-hover text-text-secondary hover:text-text-primary',
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="tab"
            type="button"
          >
            {option.label}
            {option.count === undefined ? null : (
              <span className="ml-1">{option.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function WorkbenchToolScrollArea({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3', className)}>
      {children}
    </div>
  )
}

export interface WorkbenchEmptyStateProps {
  description?: string
  icon: ReactNode
  title: string
}

export function WorkbenchEmptyState({ description, icon, title }: WorkbenchEmptyStateProps) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2.5 px-6 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-bg-hover text-text-tertiary">
        {icon}
      </span>
      <p className="text-sm text-text-tertiary">{title}</p>
      {description ? <p className="max-w-64 text-xs leading-relaxed text-text-tertiary">{description}</p> : null}
    </div>
  )
}
