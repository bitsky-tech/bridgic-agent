/**
 * Window-close-requested handler — currently the simplest Phase 1 version.
 *
 * Current state: there is no modal layer, so any close request goes straight to
 * confirmClose and lets the window close.
 *
 * Once Phase 3/4 introduces business pages, this will grow into a layered
 * dismiss:
 *   modal/overlay present → close the modal first, cancelClose (window stays)
 *   nothing present       → confirmClose (window actually closes)
 *
 * The main process's window-manager.ts has a 3s force-close fallback, so a
 * failure or exception here won't leave the window stuck.
 */
import { atom } from 'jotai'
import { rlog } from '@/lib/logger'

export const handleWindowCloseAtom = atom(null, () => {
  window.api.window.confirmClose().catch((err: unknown) => {
    rlog.error('[window-close] confirmClose failed', err)
  })
})
