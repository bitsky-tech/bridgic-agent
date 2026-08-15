/**
 * Shared hover-intent for the collapsed-sidebar reveal overlay.
 *
 * The trigger (TopBar toggle icon) and the overlay panel live in different
 * component trees with a dead band between them (the top bar's empty area sits
 * above where the overlay opens). A naive enter/leave flickers when the cursor
 * crosses that band, so leaving EITHER region SCHEDULES a close that entering
 * the other CANCELS.
 *
 * Non-obvious dep: the timer is module-scoped because there is exactly one
 * reveal overlay app-wide — both consumers must share the same pending close.
 */
import { useSetAtom } from 'jotai'
import { sidebarOverlayOpenAtom } from '@/atoms/layout'

let closeTimer: ReturnType<typeof setTimeout> | null = null

/** Returns `open` / `scheduleClose` handlers for the reveal overlay. */
export function useSidebarOverlayHover() {
  const setOpen = useSetAtom(sidebarOverlayOpenAtom)

  const open = () => {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    setOpen(true)
  }

  const scheduleClose = () => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => {
      closeTimer = null
      setOpen(false)
    }, 140)
  }

  return { open, scheduleClose }
}
