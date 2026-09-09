import { useSetAtom } from 'jotai'
import type { ExcelHostSnapshot } from '@shared/types'
import { setExcelHostSnapshotAtom } from '@/atoms/excel'
import { rlog } from '@/lib/logger'
import { useOfficeSurfaceSnapshot, type OfficeSurfaceSnapshotSource } from './useOfficeSurfaceSnapshot'

const excelSnapshots: OfficeSurfaceSnapshotSource<ExcelHostSnapshot> = {
  snapshot: () => window.api.excelHost.snapshot(),
  subscribe: (listener) => window.api.events.onExcelHostChanged(listener),
  onError: (error) => rlog.warn('[excel-host] initial snapshot failed', error),
}

/** Hydrate and subscribe to the main-process inventory of Session Excel targets. */
export function useExcelHostBridge(): void {
  const setSnapshot = useSetAtom(setExcelHostSnapshotAtom)

  useOfficeSurfaceSnapshot(excelSnapshots, setSnapshot)
}
