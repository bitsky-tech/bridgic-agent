import { type RefObject, useEffect } from 'react'

const ACTIVE_CLASS = 'auto-hide-scrollbar-active'
const DEFAULT_IDLE_MS = 1000

/**
 * Shows a Windows-only custom scrollbar while its container is being used,
 * then lets the thumb fade away after a short idle period. Other platforms
 * keep their native scrollbar behaviour unchanged.
 */
export function useAutoHideScrollbar<T extends HTMLElement>(
  scrollRef: RefObject<T>,
  idleMs = DEFAULT_IDLE_MS,
): void {
  useEffect(() => {
    if (document.documentElement.dataset.platform !== 'win32') return

    const element = scrollRef.current
    if (!element) return

    let hideTimer: number | undefined
    const showTemporarily = () => {
      element.classList.add(ACTIVE_CLASS)
      if (hideTimer !== undefined) window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => {
        element.classList.remove(ACTIVE_CLASS)
        hideTimer = undefined
      }, idleMs)
    }

    element.addEventListener('scroll', showTemporarily, { passive: true })
    element.addEventListener('pointerenter', showTemporarily, { passive: true })
    element.addEventListener('pointermove', showTemporarily, { passive: true })
    element.addEventListener('pointerdown', showTemporarily, { passive: true })
    element.addEventListener('focusin', showTemporarily)

    return () => {
      if (hideTimer !== undefined) window.clearTimeout(hideTimer)
      element.classList.remove(ACTIVE_CLASS)
      element.removeEventListener('scroll', showTemporarily)
      element.removeEventListener('pointerenter', showTemporarily)
      element.removeEventListener('pointermove', showTemporarily)
      element.removeEventListener('pointerdown', showTemporarily)
      element.removeEventListener('focusin', showTemporarily)
    }
  }, [idleMs, scrollRef])
}
