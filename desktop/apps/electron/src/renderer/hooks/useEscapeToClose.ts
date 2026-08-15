/**
 * Bind the Escape key to a close handler for the duration of the
 * component's mount.
 *
 * Why a window-level listener (not a `tabIndex={-1}` + onKeyDown on the
 * modal root)? Modals open with focus on the backdrop, but as soon as
 * the user clicks any input inside the dialog, focus moves into that
 * input and a root-level handler stops firing. A window-level listener
 * survives focus shuffling and is the conventional behavior users
 * expect from Escape on a dialog.
 *
 * Invariant: when `onClose` is undefined (uncontrolled / view-only
 * modal), the hook is a no-op — nothing is registered.
 *
 * If multiple modals are open at once (not the case today but possible
 * in future), each invocation registers its own listener and Escape
 * will close all of them simultaneously. Add a z-index stack manager
 * if/when nested modals become a real pattern.
 */
import { useEffect } from 'react'

export function useEscapeToClose(onClose: (() => void) | undefined): void {
  useEffect(() => {
    if (!onClose) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
}
