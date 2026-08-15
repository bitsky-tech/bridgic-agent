/**
 * Coalesce a high-frequency callback down to at most once per frame
 * (requestAnimationFrame throttling).
 *
 * For scroll / resize style scenarios that fire once per tick while the callback reads
 * layout (`getBoundingClientRect` / `offsetHeight` = forced synchronous layout): without
 * coalescing, a single scroll can trigger dozens of layout recalculations.
 *
 * Why a **function** and not a `useThrottledRaf` hook: the typical usage wraps an
 * effect-local closure (positioning, measuring) inside a `useEffect`, and a hook can only
 * be called at the top level of a component, where it can't reach that closure. A
 * `useThrottledRaf` hook would instead target the
 * throttling inside the three **render loops** — `useSmoothStream` / `ModelPickerMenu` /
 * `Pipeline`; that hook should still be extracted some day — when it is, just wrap this
 * function, no need to copy the frame-id boilerplate again.
 */

/** A frame-throttled callback, plus a `cancel` for the pending frame. */
export interface ThrottledRaf {
  (): void
  /** Cancel the frame that hasn't fired yet. MUST be called in effect cleanup, otherwise the callback still runs once after unmount. */
  cancel: () => void
}

/**
 * Return a frame-throttled version of `fn`: multiple calls within one frame only run the
 * last one (in practice the first call schedules the frame and it executes when the frame
 * comes due — equivalent for positioning / measuring callbacks, and no need to store args).
 */
export function throttleRaf(fn: () => void): ThrottledRaf {
  let frame = 0
  const throttled = (() => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      fn()
    })
  }) as ThrottledRaf
  throttled.cancel = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  }
  return throttled
}
