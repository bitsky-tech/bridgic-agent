/**
 * Drag-drop file intake for the composer container.
 *
 * Purely the DRAG mechanics: visual flag + handing the dropped File[] to the
 * caller. What happens to the files is the caller's business — FreeFormInput
 * routes them through the SAME paste→mount pipeline as clipboard pastes
 * (classifyPaste → resolveFileItems → pasteToSessionFilesAtom), so drop /
 * paste / toolbar-pick all converge on session mounts.
 *
 * Ref counter handles nested-child dragenter/leave without flicker: each
 * child crossing fires dragenter on the parent and dragleave on the previous
 * element; counting tells us when the pointer truly left the drop zone.
 *
 * Non-obvious dep: RichTextInput's own onDrop calls preventDefault WITHOUT
 * stopPropagation — rejecting contenteditable's native inline-insert while
 * letting the event bubble here.
 */
import { useRef, useState } from 'react'

export interface ComposerFileDropResult {
  isDraggingOver: boolean
  dragProps: {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

/** Drag visuals + drop intake. `onFiles` receives the dropped File[]. */
export function useComposerFileDrop(onFiles: (files: File[]) => void): ComposerFileDropResult {
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const dragCountRef = useRef(0)

  return {
    isDraggingOver,
    dragProps: {
      onDragEnter: (e) => {
        e.preventDefault()
        dragCountRef.current += 1
        setIsDraggingOver(true)
      },
      onDragOver: (e) => {
        e.preventDefault()
      },
      onDragLeave: () => {
        dragCountRef.current = Math.max(0, dragCountRef.current - 1)
        if (dragCountRef.current === 0) setIsDraggingOver(false)
      },
      onDrop: (e) => {
        e.preventDefault()
        e.stopPropagation()
        dragCountRef.current = 0
        setIsDraggingOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) onFiles(files)
      },
    },
  }
}
