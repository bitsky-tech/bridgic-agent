import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IDocumentData } from '@univerjs/core'
import { SetDocZoomRatioOperation } from '@univerjs/docs-ui'
import { Modal } from '@/components/amphi/Modal'
import { mountWordUniverEngine, shouldCommitUniverCommand, type WordEditorNativeEngine } from '@/lib/wordEditorAdapter'
import { wordHeaderFooterContentSignature, type WordHeaderFooterDraft } from '@/lib/wordHeaderFooter'

/** Edit an isolated native segment; HTML is only an import compatibility boundary. */
export function WordHeaderFooterDialog({ draft, title, onClose, onSave, mountNative = mountWordUniverEngine }: {
  draft: WordHeaderFooterDraft
  title: string
  onClose: () => void
  onSave: (snapshot: IDocumentData) => Promise<void>
  mountNative?: typeof mountWordUniverEngine
}) {
  const { i18n, t } = useTranslation()
  const editorRef = useRef<HTMLDivElement>(null)
  const nativeRef = useRef<WordEditorNativeEngine | null>(null)
  const originalSignature = useRef('')
  const changed = useRef(false)
  const savingRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const language = useRef(i18n.language)
  const errorLabel = useRef(t('word.coreError'))

  useEffect(() => {
    let native: WordEditorNativeEngine | null = null
    let subscription: { dispose(): void } | null = null
    let focusTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const focus = async (attempt = 0) => {
      if (!native || disposed) return
      // Viewport initialization must not add entries to the user's undo history.
      await native.univerAPI.executeCommand(SetDocZoomRatioOperation.id, { unitId: draft.snapshot.id, zoomRatio: 0.8 }).catch(() => undefined)
      if (disposed) return
      const input = editorRef.current?.querySelector<HTMLElement>('[data-u-comp="editor"]')
      const bounds = input?.parentElement?.parentElement?.getBoundingClientRect()
      if (document.activeElement === input && bounds && bounds.left > -1_000 && bounds.top > -1_000) return
      if (document.activeElement instanceof HTMLElement && !editorRef.current?.contains(document.activeElement)) document.activeElement.blur()
      native.document.setSelection(0, 0)
      if (attempt < 20) focusTimer = setTimeout(() => { void focus(attempt + 1) }, 50)
    }
    const timer = setTimeout(() => {
      try {
        native = mountNative({ container: editorRef.current!, language: language.current, snapshot: structuredClone(draft.snapshot), toolbar: true })
        nativeRef.current = native
        originalSignature.current = wordHeaderFooterContentSignature(native.document.getSnapshot())
        changed.current = false
        subscription = native.univerAPI.onCommandExecuted((command) => {
          if (shouldCommitUniverCommand(command.id)) changed.current = true
        })
        setReady(true)
        // Wait until Univer's nested UI and canvas have mounted before focusing.
        focusTimer = setTimeout(() => { void focus() }, 50)
      } catch {
        subscription?.dispose()
        nativeRef.current = null
        native?.dispose()
        native = null
        setError(errorLabel.current)
      }
    }, 0)
    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(focusTimer)
      subscription?.dispose()
      nativeRef.current = null
      // Univer owns a nested React root; dispose after the parent's commit.
      if (native) { const owned = native; queueMicrotask(() => owned.dispose()) }
    }
  }, [draft, mountNative])

  const save = async () => {
    const native = nativeRef.current
    if (!ready || !native || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const snapshot = structuredClone(native.document.getSnapshot())
      if (!changed.current || wordHeaderFooterContentSignature(snapshot) === originalSignature.current) { onClose(); return }
      await onSave(snapshot)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      savingRef.current = false
      setSaving(false)
    }
  }

  return <Modal title={title} width={900} onClose={saving ? undefined : onClose}>
    <div aria-label={title} aria-modal="true" className="space-y-4 p-4" role="dialog" onKeyDownCapture={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        void save()
      }
    }}>
      <div aria-label={title} className="word-univer-host h-[min(480px,50vh)] overflow-hidden rounded-md border border-border-default bg-white text-black" data-testid="word-header-footer-editor" ref={editorRef} style={{ pointerEvents: saving ? 'none' : undefined }} />
      {error ? <div className="text-sm text-status-error" role="alert">{error}</div> : null}
      <div className="flex justify-end gap-2">
        <button className="rounded-md border border-border-default px-3 py-1.5 text-sm text-text-primary" disabled={saving} onClick={onClose} type="button">{t('common.cancel')}</button>
        <button className="rounded-md bg-brand-purple px-3 py-1.5 text-sm text-white" data-testid="word-header-footer-confirm" disabled={!ready || saving} onClick={() => { void save() }} type="button">{t('common.confirm')}</button>
      </div>
    </div>
  </Modal>
}
