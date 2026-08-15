/**
 * Base modal wrapper — title bar + tabs + content card.
 *
 * The backdrop itself is not here: it is handled uniformly by `ModalBackdrop` (portaling, stacking, the Windows caption
 * area inset and click-to-close all live in that file's four invariants). This file only owns the card.
 *
 * Pass `customHeader` to override the default title bar (used e.g. by
 * WorkflowDetailModal where the header carries its brand badge inline with
 * the title).
 *
 * Refactored to Tailwind className per §1.22.
 */

import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { Icons } from './Icons'
import { ModalBackdrop } from './ModalBackdrop'
import { Card, TabBar } from './Primitives'

export interface ModalProps {
  width?: number
  title?: ReactNode
  children: ReactNode
  onClose?: () => void
  backdropClassName?: string
  tabs?: string[]
  activeTab?: number
  onTabChange?: (i: number) => void
  customHeader?: ReactNode
  contentStyle?: CSSProperties
}

export function Modal({
  width = 720,
  title,
  children,
  onClose,
  backdropClassName,
  tabs,
  activeTab = 0,
  onTabChange,
  customHeader,
  contentStyle,
}: ModalProps) {
  useEscapeToClose(onClose)
  return (
    <ModalBackdrop onClose={onClose} backdropClassName={backdropClassName}>
      <Card
        className="max-h-[80%] flex flex-col shadow-modal border border-border-default"
        // Prop-driven width → stays inline. Clamped to 92vw so a wide modal
        // never overflows a narrow window (adaptive); no-op on normal sizes.
        style={{ width: `min(${width}px, 92vw)` }}
      >
        {customHeader ?? (
          <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between flex-shrink-0">
            <span className="text-lg font-semibold text-text-primary">{title}</span>
            <div onClick={onClose} className="cursor-pointer text-text-tertiary p-1">
              {Icons.x(18)}
            </div>
          </div>
        )}
        {tabs && <TabBar tabs={tabs} active={activeTab} onChange={onTabChange} />}
        <div className={cn('flex-1 overflow-auto')} style={contentStyle}>
          {children}
        </div>
      </Card>
    </ModalBackdrop>
  )
}
