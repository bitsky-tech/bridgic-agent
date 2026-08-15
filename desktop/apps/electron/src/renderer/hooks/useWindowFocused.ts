/**
 * Track whether the app window currently holds OS focus.
 *
 * Subscribes to window `focus` / `blur` (an external system — useEffect is
 * the right tool here, not derived state per §1.17). Consumed by the top
 * bar to dim its custom controls when the window is inactive, mirroring
 * macOS graying the native traffic lights so the chrome stays unobtrusive.
 */
import { useEffect, useState } from 'react'

/** Current window focus state; re-renders the consumer on focus/blur. */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document !== 'undefined' ? document.hasFocus() : true,
  )
  useEffect(() => {
    const on = () => setFocused(true)
    const off = () => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])
  return focused
}
