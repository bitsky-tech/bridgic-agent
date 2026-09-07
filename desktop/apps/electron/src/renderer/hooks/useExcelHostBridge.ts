import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { setExcelHostSnapshotAtom } from '@/atoms/excel'
import { rlog } from '@/lib/logger'

/** Hydrate and subscribe to the main-process inventory of Session Excel targets. */
export function useExcelHostBridge(): void {
  const setSnapshot = useSetAtom(setExcelHostSnapshotAtom)

  useEffect(() => {
    let active = true
    let receivedPush = false
    const unsubscribe = window.api.events.onExcelHostChanged((snapshot) => {
      if (!active) return
      receivedPush = true
      setSnapshot(snapshot)
    })
    void window.api.excelHost.snapshot().then(
      (snapshot) => {
        if (active && !receivedPush) setSnapshot(snapshot)
      },
      (error) => rlog.warn('[excel-host] initial snapshot failed', error),
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [setSnapshot])
}
