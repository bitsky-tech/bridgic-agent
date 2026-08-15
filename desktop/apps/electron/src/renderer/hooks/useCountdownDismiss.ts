/**
 * Count down to an automatic dismissal, exposing the remaining whole seconds so
 * a button can show them.
 *
 * For cards that are pure acknowledgements — the user has nothing left to
 * decide, so making them click again is busywork.
 *
 * Invariants:
 *   - Fires `onDone` exactly once, from an effect rather than inside a state
 *     updater (updaters can run twice under StrictMode, which would dismiss
 *     twice and, for a caller that also clears state, race itself).
 *   - The latest `onDone` is read through a ref, so a caller passing an inline
 *     arrow does not restart the countdown on every render.
 *   - The countdown starts on mount. Callers that need to restart it should
 *     remount via `key`.
 */
import { useEffect, useRef, useState } from 'react'

/**
 * @param seconds - whole seconds to count down from
 * @param onDone - called once when the countdown reaches zero
 * @returns remaining whole seconds (reaches 0 on the tick that fires `onDone`)
 */
export function useCountdownDismiss(seconds: number, onDone: () => void): number {
  const [remaining, setRemaining] = useState(seconds)
  const latestOnDone = useRef(onDone)

  useEffect(() => {
    latestOnDone.current = onDone
  })

  useEffect(() => {
    if (remaining <= 0) return
    const timer = setTimeout(() => setRemaining((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [remaining])

  useEffect(() => {
    if (remaining > 0) return
    latestOnDone.current()
  }, [remaining])

  return remaining
}
