import { describe, expect, it } from 'bun:test'
import {
  clearPresentationCanvasPreservingSelection,
  restorePresentationSelectionState,
} from '../presentationCanvasSelection'

describe('presentation canvas selection bridge', () => {
  it('does not treat a controlled Fabric rebuild as a user deselection', () => {
    const selectedElementIdRef = { current: 'shape-1' as string | null }
    const suppressSelectionRef = { current: false }

    const selectedElementId = clearPresentationCanvasPreservingSelection(
      selectedElementIdRef,
      suppressSelectionRef,
      () => {
        if (!suppressSelectionRef.current) selectedElementIdRef.current = null
      },
    )

    expect(selectedElementId).toBe('shape-1')
    expect(selectedElementIdRef.current).toBe('shape-1')
    expect(suppressSelectionRef.current).toBe(false)
  })

  it('restores both the mutable Fabric bridge and React selection state', () => {
    const selectedElementIdRef = { current: null as string | null }
    const restoredElementIds: string[] = []

    restorePresentationSelectionState('shape-1', selectedElementIdRef, (elementId) => {
      restoredElementIds.push(elementId)
    })

    expect(selectedElementIdRef.current).toBe('shape-1')
    expect(restoredElementIds).toEqual(['shape-1'])
  })
})
