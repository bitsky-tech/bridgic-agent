import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type SurfaceStatus = 'active' | 'background-open' | 'attention' | 'running'

/** Keep open-state styling attached to the icon, with a stable footprint in every state. */
export function SurfaceStatusIcon({ busy = false, children, pulsing = false, selected = false, state, testId }: {
  busy?: boolean
  children: ReactNode
  pulsing?: boolean
  selected?: boolean
  state?: SurfaceStatus
  testId: string
}) {
  const attention = state === 'attention'
  const appearance = selected ? 'selection-capsule' : 'icon-tile'
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-9 shrink-0 items-center justify-center"
      data-selected={selected || undefined}
      data-state={state}
      data-testid={state ? testId : undefined}
      data-appearance={state ? appearance : undefined}
    >
      <span className={cn(
        'flex h-[26px] w-[26px] items-center justify-center rounded-lg transition-colors duration-200 motion-reduce:transition-none',
        state === 'background-open' && !busy && 'bg-accent-purple-subtle text-text-accent-purple',
        busy && !attention && 'bg-accent-blue-subtle text-text-accent',
        attention && 'text-status-warning',
        selected && 'h-7 w-9 rounded-full bg-text-primary/10 text-text-primary',
        selected && busy && !attention && 'bg-brand-blue/15 text-text-accent',
        selected && attention && 'bg-status-warning-bg text-status-warning',
      )}>
        <span className={cn(
          'flex items-center justify-center',
          pulsing && !attention && 'animate-pulse motion-reduce:animate-none',
        )}>
          {children}
        </span>
      </span>
    </span>
  )
}
