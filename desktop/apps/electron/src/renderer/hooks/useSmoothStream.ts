/**
 * Smooth-stream hook: turn high-frequency text updates into 60fps
 * perceived typing.
 *
 * Pipeline streaming arrives in irregular chunks (network jitter +
 * agent-server timer step). Without smoothing the UI jumps in spurts;
 * with this hook each rAF tick reveals up to 3 chars, producing a
 * smooth ~180 char/s reveal regardless of the raw chunk cadence.
 *
 * Fast-forward branches:
 *   - `raw` length shrunk (stream reset)         → snap smooth to raw
 *   - smooth lags raw by > 200 chars             → snap (avoid catch-up
 *                                                    death-spiral on
 *                                                    long messages)
 *
 * Non-obvious dep: the effect intentionally only depends on `raw`; the
 * `smooth` value inside is read via closure each effect run. ESLint's
 * exhaustive-deps would flag this — disabled inline.
 */
import { useEffect, useRef, useState } from 'react'

/** Snap (skip smoothing) when smooth lags raw by more than this many chars —
 *  prevents a catch-up death-spiral on long messages. */
const SNAP_LAG_THRESHOLD = 200
/** Chars revealed per rAF tick → ~180 char/s perceived typing at 60fps. */
const REVEAL_CHARS_PER_TICK = 3

/** rAF-paced text reveal. Returns '' when `raw` is undefined / null. */
export function useSmoothStream(raw: string | undefined): string {
  const [smooth, setSmooth] = useState('')
  const rafRef = useRef<number | undefined>(undefined)

  /*
   * `set-state-in-effect` and `exhaustive-deps` are intentionally violated:
   *   - The snap-to-raw branches must set state synchronously when smoothing
   *     is skipped (raw shrank, or we lag too far). Scheduling a separate
   *     rAF for that would defeat the fast-forward path's purpose.
   *   - The effect intentionally reads `smooth.length` via closure (initial
   *     revealed = current reveal). Including `smooth` in deps would create a new
   *     rAF cycle for every tick, breaking the smoothing.
   */
  useEffect(() => {
    if (raw === undefined || raw === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSmooth('')
      return
    }
    let revealed = smooth.length

    // Smooth got ahead of raw (raw shrank, e.g. session switch) — snap.
    if (revealed > raw.length) {
      setSmooth(raw)
      return
    }
    // Too far behind: skip smoothing to avoid frame budget overrun.
    if (raw.length - revealed > SNAP_LAG_THRESHOLD) {
      setSmooth(raw)
      return
    }
    if (revealed >= raw.length) return

    const tick = () => {
      revealed = Math.min(raw.length, revealed + REVEAL_CHARS_PER_TICK)
      setSmooth(raw.slice(0, revealed))
      if (revealed < raw.length) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw])

  return smooth
}
