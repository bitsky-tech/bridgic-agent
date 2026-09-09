import { useSetAtom } from 'jotai'
import type { WordHostSnapshot } from '@shared/types'
import { wordHostSnapshotAtom } from '@/atoms/word'
import { rlog } from '@/lib/logger'
import { useOfficeSurfaceSnapshot, type OfficeSurfaceSnapshotSource } from './useOfficeSurfaceSnapshot'

const source: OfficeSurfaceSnapshotSource<WordHostSnapshot> = {
  snapshot: () => window.api.wordHost.snapshot(),
  subscribe: (listener) => window.api.events.onWordHostChanged(listener),
  onError: (error) => rlog.warn('[word-host] initial snapshot failed', error),
}

export function useWordHostBridge(): void {
  useOfficeSurfaceSnapshot(source, useSetAtom(wordHostSnapshotAtom))
}
