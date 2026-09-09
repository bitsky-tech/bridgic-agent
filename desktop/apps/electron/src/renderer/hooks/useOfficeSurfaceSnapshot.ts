import { useEffect } from 'react'

export interface OfficeSurfaceSnapshotSource<T> {
  snapshot: () => Promise<T>
  subscribe: (listener: (snapshot: T) => void) => () => void
  onError: (error: unknown) => void
}

/** Subscribe before reading the inventory so a late initial read cannot undo a push. */
export function useOfficeSurfaceSnapshot<T>(source: OfficeSurfaceSnapshotSource<T>, publish: (snapshot: T) => void): void {
  useEffect(() => {
    let active = true
    let receivedPush = false
    const unsubscribe = source.subscribe((snapshot) => {
      if (!active) return
      receivedPush = true
      publish(snapshot)
    })
    void source.snapshot().then(
      (snapshot) => {
        if (active && !receivedPush) publish(snapshot)
      },
      (error) => {
        if (active) source.onError(error)
      },
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [publish, source])
}
