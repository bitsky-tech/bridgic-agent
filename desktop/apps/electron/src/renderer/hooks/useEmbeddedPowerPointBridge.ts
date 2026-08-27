import { useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { setEmbeddedPowerPointSnapshotAtom } from '@/atoms/powerpoint'
import { rlog } from '@/lib/logger'

/** Hydrate and subscribe to Electron-owned PowerPoint surface state. */
export function useEmbeddedPowerPointBridge(): void {
  const setSnapshot = useSetAtom(setEmbeddedPowerPointSnapshotAtom)

  useEffect(() => {
    let active = true
    let receivedPush = false
    const unsubscribe = window.api.events.onEmbeddedPowerPointChanged((snapshot) => {
      if (!active) return
      receivedPush = true
      setSnapshot(snapshot)
    })
    void window.api.powerpoint.snapshot().then(
      (snapshot) => {
        if (active && !receivedPush) setSnapshot(snapshot)
      },
      (error) => {
        if (active) rlog.warn('[embedded-powerpoint] initial snapshot failed', error)
      },
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [setSnapshot])
}
