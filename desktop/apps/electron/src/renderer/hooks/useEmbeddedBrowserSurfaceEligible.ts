/**
 * Resolve whether renderer state currently permits the native Browser surface.
 *
 * This is eligibility, not a native show acknowledgement: renderer overlays
 * and explicit blockers can prevent presentation before Electron receives the
 * measured bounds and setVisible request.
 */
import { useAtomValue } from 'jotai'
import type { EmbeddedBrowserTabInfo } from '@shared/types'
import { activeModalAtom } from '@/atoms/amphi'
import { browserSurfaceBlockedAtom } from '@/atoms/browser'
import { confirmRequestAtom } from '@/atoms/confirm'
import { externalLinkRequestAtom } from '@/atoms/external-link'
import { issueReportRequestAtom } from '@/atoms/issue-report'
import { lightboxItemAtom } from '@/atoms/lightbox'
import { scheduleOverlayAtom } from '@/atoms/schedules'

/** Whether renderer state allows the active native Browser page to be shown. */
export function useEmbeddedBrowserSurfaceEligible(
  presentationRequested: boolean,
  activeTab: EmbeddedBrowserTabInfo | null,
): boolean {
  const surfaceBlocked = useAtomValue(browserSurfaceBlockedAtom)
  const activeModal = useAtomValue(activeModalAtom)
  const confirm = useAtomValue(confirmRequestAtom)
  const externalLink = useAtomValue(externalLinkRequestAtom)
  const issueReport = useAtomValue(issueReportRequestAtom)
  const lightbox = useAtomValue(lightboxItemAtom)
  const scheduleOverlay = useAtomValue(scheduleOverlayAtom)
  const overlayOpen = Boolean(
    activeModal || confirm || externalLink || issueReport || lightbox || scheduleOverlay,
  )

  return presentationRequested
    && !surfaceBlocked
    && !overlayOpen
    && activeTab !== null
    && !activeTab.crashed
}
