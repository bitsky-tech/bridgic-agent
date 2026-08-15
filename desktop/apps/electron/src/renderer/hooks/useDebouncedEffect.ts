/**
 * Trailing-debounce a side effect on dependency change.
 *
 * Runs `effect` after `deps` stop changing for `delay`ms. Each dep change
 * restarts the timer and cancels the pending run; unmount cancels too — so
 * only the last settled value fires. Replaces the hand-rolled
 * `setTimeout`/`clearTimeout`-in-a-useEffect boilerplate that was duplicated
 * across consumers (persist-on-type, search-on-type).
 *
 * `effect` is read from a ref at fire time, so it always sees the latest
 * closure: list in `deps` only what should (re)start the debounce, not every
 * value the effect reads.
 *
 * For coalescing async work, guard stale responses yourself (e.g. a seq ref) —
 * this hook only debounces the trigger, it doesn't track in-flight results.
 */
import { useEffect, useRef, type DependencyList } from 'react'

export function useDebouncedEffect(
  effect: () => void,
  deps: DependencyList,
  delay: number,
): void {
  // Keep the latest closure without re-arming the debounce — updated in an
  // effect (not during render) so the linter's no-ref-write-in-render holds.
  const effectRef = useRef(effect)
  useEffect(() => {
    effectRef.current = effect
  })

  useEffect(() => {
    const timer = setTimeout(() => effectRef.current(), delay)
    return () => clearTimeout(timer)
    // Spreading `deps` is the whole point — the consumer owns the trigger list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, delay])
}
