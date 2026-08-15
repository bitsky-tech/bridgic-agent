/**
 * Persist per-session staged brief comments (unsent selection comments) across
 * app restarts, via the `spec-comments.json` blob (window.api.specComments).
 *
 * Thin wrapper over useBlobPersistence (§1.27) — the same load-once +
 * gated-save orchestration as useDraftPersistence, except nothing is pruned
 * (comments are persisted per session exactly as-is).
 *
 * Mounted once in App.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { allPendingCommentsAtom, setAllPendingCommentsAtom, type PendingComment } from '@/atoms/build'
import { useBlobPersistence } from './useBlobPersistence'

export function useSpecCommentPersistence(): void {
  const pending = useAtomValue(allPendingCommentsAtom)
  const setAll = useSetAtom(setAllPendingCommentsAtom)
  useBlobPersistence<PendingComment[]>(
    pending,
    setAll,
    window.api.specComments.load,
    window.api.specComments.save,
    'spec-comments',
  )
}
