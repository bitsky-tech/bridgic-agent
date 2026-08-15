/**
 * Persist per-session composer drafts (unsent input, incl. @ mention chips)
 * across app restarts, via the `drafts.json` blob (window.api.drafts).
 *
 * Thin wrapper over useBlobPersistence (§1.27): drafts prune empty + retired entries
 * before saving (`pruneDrafts`) to keep the blob lean. The load-once +
 * gated-save orchestration + invariants all live in useBlobPersistence.
 *
 * Mounted once in App.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { pruneDrafts, sessionDraftsAtom, setAllDraftsAtom } from '@/atoms/sessions'
import type { Segment } from '@/components/composer/segments'
import { useBlobPersistence } from './useBlobPersistence'

export function useDraftPersistence(): void {
  const drafts = useAtomValue(sessionDraftsAtom)
  const setAllDrafts = useSetAtom(setAllDraftsAtom)
  useBlobPersistence<Segment[]>(
    drafts,
    setAllDrafts,
    window.api.drafts.load,
    window.api.drafts.save,
    'drafts',
    pruneDrafts,
  )
}
