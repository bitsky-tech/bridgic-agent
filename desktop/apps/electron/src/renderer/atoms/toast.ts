/**
 * Lightweight transient toast — one message at a time, auto-dismissed.
 *
 * Producers call `showToastAtom` with a message; `ToastHost` (mounted once
 * in App.tsx) renders the current one. A newer toast replaces the current
 * immediately; each toast's own timer only clears the slot if it is still
 * the active one (id guard), so rapid successive toasts don't get cut
 * short by a stale timer.
 */
import { atom } from 'jotai'

/** Auto-dismiss delay. Short on purpose — this is a confirmation blip,
 *  not a notification center. */
const TOAST_DURATION_MS = 2000

interface Toast {
  /** Monotonic-enough identity for the stale-timer guard. */
  id: number
  message: string
}

const _toast = atom<Toast | null>(null)

/** Read: the toast currently on screen (null when none). */
export const toastAtom = atom((get) => get(_toast))

/** Action: show a transient toast (replaces any visible one). */
export const showToastAtom = atom(null, (get, set, message: string) => {
  const id = Date.now() + Math.random()
  set(_toast, { id, message })
  setTimeout(() => {
    // Only clear if this toast is still the visible one — a newer toast
    // owns the slot and its own timer.
    if (get(_toast)?.id === id) set(_toast, null)
  }, TOAST_DURATION_MS)
})
