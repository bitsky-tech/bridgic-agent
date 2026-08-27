interface MutableRef<T> {
  current: T
}

/** Clear transient Fabric state without turning a canvas rebuild into a user deselection. */
export function clearPresentationCanvasPreservingSelection(
  selectedElementIdRef: MutableRef<string | null>,
  suppressSelectionRef: MutableRef<boolean>,
  clear: () => void,
): string | null {
  const selectedElementId = selectedElementIdRef.current
  const wasSuppressed = suppressSelectionRef.current
  suppressSelectionRef.current = true
  try {
    clear()
  } finally {
    suppressSelectionRef.current = wasSuppressed
  }
  return selectedElementId
}

/** Keep React and Fabric selection state aligned after programmatic restoration. */
export function restorePresentationSelectionState(
  elementId: string,
  selectedElementIdRef: MutableRef<string | null>,
  setSelectedElementId: (elementId: string) => void,
): void {
  selectedElementIdRef.current = elementId
  setSelectedElementId(elementId)
}
