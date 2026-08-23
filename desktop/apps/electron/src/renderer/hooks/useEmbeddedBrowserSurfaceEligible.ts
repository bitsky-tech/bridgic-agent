/**
 * Resolve whether renderer state currently permits the native Browser surface.
 *
 * This is eligibility, not a native show acknowledgement: renderer overlays
 * and explicit blockers can prevent presentation before Electron receives the
 * measured bounds and setVisible request.
 *
 * Overlays are read through ONE channel — `browserSurfaceBlockedAtom`, fed by
 * `useBrowserSurfaceBlocker`. This used to enumerate the overlay atoms one by
 * one instead, which meant every new global overlay had to remember to come
 * back and edit this file, with nothing to catch it if it did not: both the
 * auto-update card and the model picker shipped drawn underneath the native
 * view that way. `ModalBackdrop` now registers a blocker for every dialog that
 * wraps it, so the only overlays that need to think about this are the ones
 * that cannot use it (YARL's lightbox, the non-blocking update card).
 */
import { useAtomValue } from 'jotai'
import type { EmbeddedBrowserTabInfo } from '@shared/types'
import { browserSurfaceBlockedAtom } from '@/atoms/browser'

/** Whether renderer state allows the active native Browser page to be shown. */
export function useEmbeddedBrowserSurfaceEligible(
  presentationRequested: boolean,
  activeTab: EmbeddedBrowserTabInfo | null,
): boolean {
  const surfaceBlocked = useAtomValue(browserSurfaceBlockedAtom)

  return presentationRequested
    && !surfaceBlocked
    && activeTab !== null
    && !activeTab.crashed
}
