import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { closeOfficeSurfaceAtom } from '@/atoms/office'
import { SessionWorkbenchSurface } from '@/atoms/workbench'

/** Keep close notifications alive across Session navigation and non-workbench pages. */
export function useOfficeCloseBridge(): void {
  const closeSurface = useSetAtom(closeOfficeSurfaceAtom)
  useEffect(() => {
    const events = window.api.events
    const unsubscribe = [
      events.onExcelHostCloseRequested?.((sessionId) => closeSurface({ sessionId, surface: SessionWorkbenchSurface.Excel })),
      events.onWordHostCloseRequested?.((sessionId) => closeSurface({ sessionId, surface: SessionWorkbenchSurface.Word })),
      events.onPowerPointCloseRequested?.((sessionId) => closeSurface({ sessionId, surface: SessionWorkbenchSurface.Presentation })),
    ]
    return () => { unsubscribe.forEach((dispose) => dispose?.()) }
  }, [closeSurface])
}
