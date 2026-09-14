import { useSetAtom } from 'jotai'
import type { EmbeddedPowerPointSnapshot } from '@shared/types'
import { setEmbeddedPowerPointSnapshotAtom } from '@/atoms/powerpoint'
import { rlog } from '@/lib/logger'
import { useOfficeSurfaceSnapshot, type OfficeSurfaceSnapshotSource } from './useOfficeSurfaceSnapshot'

const powerPointSnapshots: OfficeSurfaceSnapshotSource<EmbeddedPowerPointSnapshot> = {
  snapshot: () => window.api.powerpoint.snapshot(),
  subscribe: (listener) => window.api.events.onEmbeddedPowerPointChanged(listener),
  onError: (error) => rlog.warn('[embedded-powerpoint] initial snapshot failed', error),
}

/** Hydrate and subscribe to Electron-owned PowerPoint surface state. */
export function useEmbeddedPowerPointBridge(): void {
  const setSnapshot = useSetAtom(setEmbeddedPowerPointSnapshotAtom)

  useOfficeSurfaceSnapshot(powerPointSnapshots, setSnapshot)
}
