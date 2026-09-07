/**
 * Shared chrome for the Session right dock's tool surfaces and transient Agent overlays.
 *
 * These components are renderer-owned: native Browser visibility is coordinated by
 * SessionResourcePanel before a surface becomes active. All motion is paint-only and
 * reduced-motion users receive the same state changes without decorative animation.
 */
import { useState } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { AgentDockEntry } from './AgentDockEntry'

export interface WorkbenchSurfaceProps {
  isActive: boolean
  children: ReactNode
  labelledBy: string
  testId: string
}

/** Keep a renderer workbench tool mounted while exposing only the selected surface. */
export function WorkbenchSurface({
  isActive,
  children,
  labelledBy,
  testId,
}: WorkbenchSurfaceProps) {
  return (
    <div
      id={testId}
      role="tabpanel"
      aria-hidden={!isActive}
      aria-labelledby={labelledBy}
      {...(!isActive ? { inert: '' } : {})}
      className={cn(
        'absolute inset-0 z-10 bg-bg-surface',
        isActive
          ? 'visible animate-workbench-tool-enter motion-reduce:animate-none'
          : 'invisible pointer-events-none',
      )}
      data-testid={testId}
    >
      {children}
    </div>
  )
}

export interface ModeSurfaceGateProps {
  shouldAwaitNativeHide: boolean
  children: ReactNode
  nativeHideAcknowledgement: number
}

/** Reveal an Agent mode surface only after the native Browser confirms it is hidden. */
export function ModeSurfaceGate({
  shouldAwaitNativeHide,
  children,
  nativeHideAcknowledgement,
}: ModeSurfaceGateProps) {
  const { t } = useTranslation()
  const [handoff] = useState(() => ({
    acknowledgement: nativeHideAcknowledgement,
    required: shouldAwaitNativeHide,
  }))
  const isReady = !shouldAwaitNativeHide
    || !handoff.required
    || nativeHideAcknowledgement !== handoff.acknowledgement
  return (
    <div
      id="session-surface-mode"
      role="tabpanel"
      aria-busy={!isReady}
      className="absolute inset-0 z-20 h-full bg-bg-surface"
      data-testid="session-mode-surface"
    >
      {isReady ? (
        <div className="h-full animate-mode-surface-enter motion-reduce:animate-none">
          {children}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center gap-2 text-xs text-text-tertiary" role="status">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border-default border-t-brand-purple motion-reduce:animate-none" />
          {t('session.resourcePanel.preparingMode')}
        </div>
      )}
    </div>
  )
}

export interface SurfaceRailButtonProps {
  isActive: boolean
  ariaLabel: string
  controls: string
  icon: ReactNode
  label: string
  onClick: () => void
  isOpenInBackground?: boolean
  showActiveIndicator?: boolean
  isBusy?: boolean
  isPulsing?: boolean
  isSelected: boolean
  needsAttention?: boolean
  testId: string
}

/** One keyboard-navigable tool entry in the permanent Session surface rail. */
export function SurfaceRailButton({
  isActive,
  ariaLabel,
  controls,
  icon,
  label,
  onClick,
  isOpenInBackground = false,
  showActiveIndicator = true,
  isBusy = false,
  isPulsing = false,
  isSelected,
  needsAttention = false,
  testId,
}: SurfaceRailButtonProps) {
  const showAttention = needsAttention
  let statusIndicatorState = 'background-open'
  if (showAttention) statusIndicatorState = 'attention'
  else if (isActive) statusIndicatorState = 'active'
  return (
    <button
      id={`${testId}-tab`}
      type="button"
      role="tab"
      aria-controls={controls}
      aria-expanded={isActive}
      aria-label={ariaLabel}
      aria-selected={isActive}
      aria-busy={isBusy || undefined}
      tabIndex={isSelected ? 0 : -1}
      data-attention={showAttention || undefined}
      data-testid={testId}
      onClick={onClick}
      onKeyDown={navigateSurfaceRail}
      className={cn(
        'relative flex h-[50px] w-full flex-col items-center justify-center gap-1 rounded-[10px]',
        'border border-transparent text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary',
        isActive && 'bg-bg-selected text-text-primary',
        isBusy && !showAttention && 'border-brand-blue/30 bg-accent-blue-subtle text-text-accent',
        showAttention && 'animate-surface-attention border-status-warning/40 bg-status-warning-bg text-status-warning hover:bg-status-warning-bg hover:text-status-warning motion-reduce:animate-none',
      )}
    >
      {(isActive && showActiveIndicator) || isOpenInBackground || showAttention ? (
        <span
          aria-hidden="true"
          className={cn(
            'absolute -right-[3px] top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full',
            showAttention ? 'bg-status-warning' : 'bg-text-secondary/65',
          )}
          data-state={statusIndicatorState}
          data-testid={`${testId}-status-indicator`}
        />
      ) : null}
      <span className={cn(
        'flex h-5 items-center justify-center',
        isBusy && !showAttention && 'text-text-accent',
        isPulsing && 'animate-pulse motion-reduce:animate-none',
      )}>
        {icon}
      </span>
      {/* 58px is the button's real content box (rail 68 − mx-0.5 4 − dock border 2 − p-px 2 −
          this button's own border 2). It has to be stated explicitly: `truncate` needs a
          definite width, and a flex column's `items-center` lets an oversized child overflow
          instead of clamping it. `tracking-tight` buys back the last couple of pixels so the
          English labels fit without widening the rail or shortening the product's vocabulary. */}
      <span className="max-w-[58px] truncate text-2xs font-medium leading-none tracking-tight">{label}</span>
    </button>
  )
}

export interface SessionSurfaceRailProps {
  children: ReactNode
  isAgentActive: boolean
  isContentOpen: boolean
  modeAriaLabel: string
  isModeAvailable: boolean
  onOpenMode: () => void
  railAriaLabel: string
  railRef: Ref<HTMLDivElement>
}

/** Frame the permanent Bridgic entry and tool tablist at the far right of a Session. */
export function SessionSurfaceRail({
  children,
  isAgentActive,
  isContentOpen,
  modeAriaLabel,
  isModeAvailable,
  onOpenMode,
  railAriaLabel,
  railRef,
}: SessionSurfaceRailProps) {
  return (
    <div
      ref={railRef}
      className={cn(
        'flex h-full min-h-0 w-[68px] shrink-0 flex-col overflow-y-auto overscroll-contain border-l py-2',
        'transition-[background-color,border-color] duration-200 ease-out motion-reduce:transition-none',
        isContentOpen
          ? 'border-border-subtle bg-bg-hover/70'
          : 'border-transparent bg-transparent',
      )}
      data-presentation={isContentOpen ? 'attached' : 'floating'}
      data-testid="session-surface-rail"
    >
      <div
        className={cn(
          // Inset and padding are kept minimal on purpose: every pixel spent on chrome
          // here is a pixel the labels lose, and the longest of them ("Workflows") needs
          // ~56px of the rail's 68. See SurfaceRailButton for the resulting label budget.
          'mx-0.5 my-auto flex shrink-0 flex-col overflow-hidden rounded-xl border p-px',
          'transition-[background-color,border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none',
          isContentOpen
            ? 'border-transparent bg-transparent shadow-none'
            : 'border-border-default bg-bg-elevated/95 shadow-sm',
        )}
        data-presentation={isContentOpen ? 'attached' : 'floating'}
        data-testid="session-tool-dock"
      >
        <AgentDockEntry
          active={isAgentActive}
          modeAvailable={isModeAvailable}
          modeAriaLabel={modeAriaLabel}
          onOpenMode={onOpenMode}
        />
        <div className="mx-1.5 my-1 h-px shrink-0 bg-border-strong" data-testid="session-agent-divider" />
        <div role="tablist" aria-orientation="vertical" aria-label={railAriaLabel}>
          {children}
        </div>
      </div>
    </div>
  )
}

function navigateSurfaceRail(event: KeyboardEvent<HTMLButtonElement>): void {
  let direction = 0
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') direction = 1
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') direction = -1
  if (direction === 0 && event.key !== 'Home' && event.key !== 'End') return
  const rail = event.currentTarget.closest<HTMLElement>('[role="tablist"]')
  if (!rail) return
  const tabs = [...rail.querySelectorAll<HTMLButtonElement>(':scope > [role="tab"]')]
  const current = tabs.indexOf(event.currentTarget)
  if (current < 0 || tabs.length === 0) return
  event.preventDefault()
  let next = tabs[(current + direction + tabs.length) % tabs.length]
  if (event.key === 'Home') next = tabs[0]
  else if (event.key === 'End') next = tabs[tabs.length - 1]
  next?.focus()
  next?.click()
}
