/**
 * A Promise-ized state bridge for the generic confirmation dialog.
 *
 * `requestConfirm(opts)` returns Promise<boolean> — the dialog is rendered by ConfirmDialog
 * and resolves when the user clicks confirm/cancel. It replaces Electron's native
 * `window.confirm` (ugly, uncontrollable, impossible to style consistently).
 *
 * Invariant: only one pending confirmation is held at any moment. Callers agree to use it
 * serially (never popping several concurrently); if a new request is raised while the
 * previous one is still pending, the new one overwrites the slot and the old promise
 * dangles (all existing call sites are mutually exclusive actions like "leave/delete", so
 * they never run concurrently).
 */
import { atom } from 'jotai'

/** One confirmation request's payload + resolver. */
export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** true = destructive (red confirm button, for irreversible operations such as delete). */
  danger?: boolean
  resolve: (ok: boolean) => void
}

/** The options passed in when raising a confirmation (the resolver is injected inside the atom). */
export type ConfirmOptions = Omit<ConfirmRequest, 'resolve'>

const _confirmRequest = atom<ConfirmRequest | null>(null)

/** Read — subscribed by ConfirmDialog to decide whether to render the current confirmation. */
export const confirmRequestAtom = atom((get) => get(_confirmRequest))

/** Write — raise one confirmation, returning Promise<boolean> (confirm true / cancel false). */
export const requestConfirmAtom = atom(
  null,
  (_get, set, opts: ConfirmOptions): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      set(_confirmRequest, { ...opts, resolve })
    }),
)

/** Write — the user clicked confirm (true) / cancel (false): resolve the promise and clear the slot. */
export const resolveConfirmAtom = atom(null, (get, set, ok: boolean) => {
  const req = get(_confirmRequest)
  if (!req) return
  req.resolve(ok)
  set(_confirmRequest, null)
})
