import type { PresentationProject } from '@/atoms/presentation'
import type { OfficeEditorDriver, OfficeEditorLease } from './office/officeEditorBinding'

export interface PresentationEditingObject {
  isEditing?: boolean
  inCompositionMode?: boolean
  exitEditing?: () => unknown
}

/** Canvas callbacks also belong to a slide, while the common lease identifies its document. */
export function bindPresentationNativeEdit<TArgs extends unknown[]>(lease: OfficeEditorLease, slideId: string, readDocument: () => PresentationProject, apply: (...args: TArgs) => void): (...args: TArgs) => void {
  return (...args) => {
    if (!lease.isCurrent()) return
    const document = readDocument()
    if (document.id !== lease.identity.documentId || document.slides.selectedPageId !== slideId) return
    apply(...args)
  }
}

/** Fabric is a projection of the PresentationStore project, not another project store. */
export function createPresentationEditorDriver(options: {
  readSnapshot: () => PresentationProject | null
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
  } satisfies OfficeEditorDriver<PresentationProject>
}
