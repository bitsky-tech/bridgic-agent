import type { PresentationDocument } from '@/atoms/presentation'
import type { OfficeEditorDriver, OfficeEditorLease } from './office/officeEditorBinding'

export interface PresentationEditingObject {
  isEditing?: boolean
  inCompositionMode?: boolean
  exitEditing?: () => unknown
}

/** Canvas callbacks also belong to a slide, while the common lease identifies its document. */
export function bindPresentationNativeEdit<TArgs extends unknown[]>(lease: OfficeEditorLease, slideId: string, readDocument: () => PresentationDocument, apply: (...args: TArgs) => void): (...args: TArgs) => void {
  return (...args) => {
    if (!lease.isCurrent()) return
    const document = readDocument()
    if (document.id !== lease.identity.documentId || document.selectedSlideId !== slideId) return
    apply(...args)
  }
}

/** Fabric is a projection of the Jotai document, not another document snapshot store. */
export function createPresentationEditorDriver(options: {
  readSnapshot: () => PresentationDocument | null
  readEditingObject: () => PresentationEditingObject | null
  flushPendingEdit: () => void
  dispose: () => void
}) {
  return {
    readSnapshot: options.readSnapshot,
    flush(lease: OfficeEditorLease) {
      lease.assertCurrent()
      const editing = options.readEditingObject()
      if (editing?.isEditing && editing.inCompositionMode) {
        throw new Error('Finish composing the current PowerPoint text before continuing.')
      }
      options.flushPendingEdit()
      lease.assertCurrent()
      // Reuse editing:exited, which already commits one native text edit and undo entry.
      // Never copy every canvas object: reveal animations temporarily alter displayed text.
      if (editing?.isEditing) editing.exitEditing?.()
      lease.assertCurrent()
    },
    dispose: options.dispose,
  } satisfies OfficeEditorDriver<PresentationDocument>
}
