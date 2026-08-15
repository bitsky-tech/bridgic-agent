/**
 * Singleton renderer for the transient toast (atoms/toast.ts).
 *
 * Mounted ONCE in App.tsx, fixed top-center above everything
 * (z above modals; top-8 clears the window drag region / mac traffic-light
 * row). pointer-events-none: a confirmation blip must never intercept
 * clicks. Visual style follows the project's tooltip/popover language
 * (surface + 1px border + shadow-md for depth — never a halo).
 */
import { useAtomValue } from 'jotai'
import { toastAtom } from '@/atoms/toast'

export function ToastHost() {
  const toast = useAtomValue(toastAtom)
  if (!toast) return null
  return (
    <div
      // key=id makes two consecutive toasts with identical text remount as well (re-triggering the appearance animation).
      key={toast.id}
      role="status"
      className="fixed top-8 left-1/2 -translate-x-1/2 z-[200] pointer-events-none px-3.5 py-2 rounded-md border border-border-default bg-bg-surface shadow-md text-sm text-text-primary"
    >
      {toast.message}
    </div>
  )
}
