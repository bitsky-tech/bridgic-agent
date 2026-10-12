import { OfficeSaveActions } from '@/components/app/OfficeSaveActions'
import { isWordDocumentDirty } from '@/lib/wordDomain'
import type { IDocumentData } from '@univerjs/core'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut } from 'lucide-react'

import { Icons } from '@/components/amphi/Icons'
import { Tooltip } from '@/components/amphi/Tooltip'
import { OfficeAppHeader, OfficeDocumentTabs, OfficePanelControls } from '@/components/app/OfficeWorkbenchChrome'
import { cn } from '@/lib/cn'
import type {
  WordDomainStore,
  WordFormattingCommand,
  WordPageSettings,
  WordTableAction,
} from '@/lib/wordDomain'
import type { WordPersistenceStatus } from '@/lib/wordPersistence'
import { calculateWordFitZoom, getWordPageWidth } from '@/lib/wordZoom'
import {
  getUniverHeadings,
  getUniverPageCount,
  getUniverWordCount,
} from '@/lib/wordUniverModel'
import { createWordEditorAdapter, type WordEditorRuntime } from '@/lib/wordEditorAdapter'
import { createWordHeaderFooterDraft, mergeWordHeaderFooterDraft, type WordHeaderFooterDraft } from '@/lib/wordHeaderFooter'

export { replaceUniverSnapshotWithRetry, shouldCommitUniverCommand } from '@/lib/wordEditorAdapter'

import { WordRibbon, type WordRibbonTab } from './WordRibbon'
import { WordHeaderFooterDialog } from './WordHeaderFooterDialog'

export interface StructuredWordEditorProps {
  expanded: boolean
  onClose?: () => void
  onSaveRequested?: () => void | Promise<void>
  onFlushHandlerChange?: (flush: (() => Promise<void>) | null) => void
  onToggleExpanded: () => void
  persistenceStatus?: WordPersistenceStatus
  operationError?: string | null
  showExpandControl?: boolean
  store: WordDomainStore
}

type WordZoomMode = 'fit' | 'manual'
type WordExportIntent = { documentId: string; saveAs: boolean; destination?: string }

/** Univer OSS-backed Word frontend shared by the right dock and Session-owned renderer target. */
export function StructuredWordEditor({
  expanded,
  onClose,
  onSaveRequested,
  onFlushHandlerChange,
  onToggleExpanded,
  persistenceStatus = 'saved',
  operationError,
  showExpandControl = true,
  store,
}: StructuredWordEditorProps) {
  const { i18n, t } = useTranslation()
  const workspace = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const activeDocument = workspace.documents.find((item) => item.id === workspace.activeDocumentId) ?? workspace.documents[0]!
  const imageInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [activeRibbonTab, setActiveRibbonTab] = useState<WordRibbonTab>('home')
  const [ribbonCollapsed, setRibbonCollapsed] = useState(false)
  const [rulerVisible, setRulerVisible] = useState(true)
  const [tableActive, setTableActive] = useState(false)
  const [zoom, setZoom] = useState(expanded ? 100 : 75)
  const [zoomMode, setZoomMode] = useState<WordZoomMode>('fit')
  const [runtime, setRuntime] = useState<WordEditorRuntime | null>(null)
  const editorFlushRef = useRef<{ documentId: string; flush: () => Promise<void> } | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [editingHeaderFooter, setEditingHeaderFooter] = useState<WordHeaderFooterDraft | null>(null)

  const setEditorRuntime = useCallback((next: WordEditorRuntime | null, documentId: string) => {
    if (next && store.getSnapshot().activeDocumentId !== documentId) return
    setRuntime((current) => next ?? (current?.documentId === documentId ? null : current))
  }, [store])
  const setEditorFlush = useCallback((flush: (() => Promise<void>) | null, documentId: string) => {
    if (flush) {
      if (store.getSnapshot().activeDocumentId !== documentId) return
      editorFlushRef.current = { documentId, flush }
      onFlushHandlerChange?.(flush)
    } else if (editorFlushRef.current?.documentId === documentId) {
      editorFlushRef.current = null
      onFlushHandlerChange?.(null)
    }
  }, [onFlushHandlerChange, store])
  const setEditorTableActive = useCallback((active: boolean, documentId: string) => {
    if (store.getSnapshot().activeDocumentId === documentId) setTableActive(active)
  }, [store])

  useLayoutEffect(() => {
    if (zoomMode !== 'fit') return
    const canvas = canvasRef.current
    if (!canvas) return

    const updateZoom = (width = canvas.clientWidth) => {
      if (width <= 0) return
      const nextZoom = calculateWordFitZoom(width, activeDocument.page)
      setZoom((currentZoom) => currentZoom === nextZoom ? currentZoom : nextZoom)
    }

    updateZoom()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => updateZoom(entries[0]?.contentRect.width))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [activeDocument.page, zoomMode])

  const changeZoom = (nextZoom: number) => {
    setZoomMode('manual')
    setZoom(nextZoom)
  }

  const fitPageWidth = () => {
    setZoomMode('fit')
    const width = canvasRef.current?.clientWidth ?? 0
    if (width > 0) setZoom(calculateWordFitZoom(width, activeDocument.page))
  }

  const flushActiveSnapshot = () => {
    if (runtime?.documentId === activeDocument.id) runtime.commit()
  }

  const runEditingCommand = (command: WordFormattingCommand, value?: string) => {
    void store.dispatch({ type: 'editor.format', action: command, value })
  }

  const insertHtml = (html: string) => { void store.dispatch({ type: 'editor.insert', kind: 'html', html }) }

  const insertLink = () => {
    const value = window.prompt(t('word.linkPrompt'), 'https://')?.trim()
    if (value && /^(https?:|mailto:)/i.test(value)) void store.dispatch({ type: 'editor.insert', kind: 'link', href: value })
  }

  const insertTableOfContents = () => {
    const currentSnapshot = runtime?.documentId === activeDocument.id ? runtime.document.getSnapshot() : activeDocument.snapshot
    const entries = getUniverHeadings(currentSnapshot)
    void store.dispatch({
      type: 'editor.insert',
      kind: 'tableOfContents',
      title: t('word.tableOfContents'),
      entries: entries.length > 0 ? entries : [{ level: 1, text: t('word.contentsEmpty') }],
    })
  }

  const insertFootnote = () => {
    const text = window.prompt(t('word.footnotePrompt'))?.trim()
    if (!text) return
    void store.dispatch({
      type: 'editor.insert',
      kind: 'footnote',
      id: createReferenceId('footnote'),
      number: activeDocument.footnotes.length + 1,
      text,
    })
  }

  const insertCitation = () => {
    const text = window.prompt(t('word.citationPrompt'))?.trim()
    if (text) void store.dispatch({ type: 'editor.insert', kind: 'citation', id: createReferenceId('citation'), text })
  }

  const insertCaption = () => {
    const caption = window.prompt(t('word.captionPrompt'))?.trim()
    if (caption) void store.dispatch({ type: 'editor.insert', kind: 'html', html: `<p style="text-align:center">${escapeHtml(caption)}</p>` })
  }

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !file.type.startsWith('image/') || file.size > 8 * 1024 * 1024) return
    const documentId = activeDocument.id
    setImageError(null)
    void readFileAsDataUrl(file)
      .then((src) => store.dispatch({ type: 'editor.insert', documentId, kind: 'image', src, alt: file.name, title: file.name }))
      .then((result) => { if (!result.ok) setImageError(result.error.message) })
      .catch((error) => setImageError(error instanceof Error ? error.message : String(error)))
  }

  const editHeaderFooter = (field: 'headerHtml' | 'footerHtml') => {
    flushActiveSnapshot()
    const current = store.getSnapshot().documents.find((document) => document.id === activeDocument.id)
    if (current) setEditingHeaderFooter(createWordHeaderFooterDraft(current.snapshot, field))
  }

  const [saveError, setSaveError] = useState<string | null>(null)
  const [tabError, setTabError] = useState<string | null>(null)
  const [checkpointError, setCheckpointError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const failedExportRef = useRef<WordExportIntent | null>(null)
  const save = (saveAs: boolean, retry = false) => {
    if (savingRef.current) return
    const intent = retry && failedExportRef.current
      ? failedExportRef.current
      : { documentId: activeDocument.id, saveAs }
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    setCheckpointError(null)
    void store.dispatch({ type: intent.saveAs ? 'document.saveAs' : 'document.save', documentId: intent.documentId, ...(intent.destination ? { destination: intent.destination } : {}) }).then(async (result) => {
      if (!result.ok) {
        failedExportRef.current = result.error.code === 'save_incomplete' ? null : intent
        if (result.error.code !== 'save_incomplete') setSaveError(result.error.message)
        return
      }
      failedExportRef.current = null
      try { await onSaveRequested?.() } catch (error) { setCheckpointError(error instanceof Error ? error.message : String(error)) }
    }).catch((error) => {
      failedExportRef.current = intent
      setSaveError(error instanceof Error ? error.message : String(error))
    }).finally(() => { savingRef.current = false; setSaving(false) })
  }
  const retryCheckpoint = () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setCheckpointError(null)
    void Promise.resolve().then(() => onSaveRequested?.()).catch((error) => {
      setCheckpointError(error instanceof Error ? error.message : String(error))
    }).finally(() => { savingRef.current = false; setSaving(false) })
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      if (editingHeaderFooter) return
      event.preventDefault()
      save(event.shiftKey)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const wordCount = getUniverWordCount(activeDocument.snapshot)
  const pageCount = getUniverPageCount(activeDocument.snapshot)

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-app" data-testid="word-workbench">
      <OfficeAppHeader
        icon={Icons.wordDocument(16)}
        iconClassName="bg-blue-500/10 text-blue-600 dark:text-blue-400"
        subtitle={t('word.sessionTargetReady', { target: workspace.sessionId.slice(0, 8).toUpperCase() })}
        testId="word-app-header"
        title="Word"
      >
        <OfficePanelControls
          closeLabel={t('word.closePanel')}
          expanded={expanded}
          expandLabel={expanded ? t('word.exitExpanded') : t('word.expand')}
          onClose={onClose}
          onToggleExpanded={showExpandControl ? onToggleExpanded : undefined}
          testIdPrefix="word"
          toggleTestId="word-expand-toggle"
        />
      </OfficeAppHeader>
      <OfficeDocumentTabs
        actions={<>
          <button className="rounded px-2 py-1 text-xs hover:bg-bg-hover disabled:opacity-50" data-testid="word-save" disabled={saving} onClick={() => save(false)} type="button">{t('office.save')}</button>
          <button className="rounded px-2 py-1 text-xs hover:bg-bg-hover disabled:opacity-50" data-testid="word-save-as" disabled={saving} onClick={() => save(true)} type="button">{t('office.saveAs')}</button>
          <OfficeSaveActions dirty={persistenceStatus === 'saving'} error={saveError} disabled={saving} onSave={() => save(false, true)} />
          {persistenceStatus === 'error' || checkpointError ? (
          <span className="max-w-28 truncate text-[10px] text-status-error" role="alert">
            {t('word.persistence.error')}
          </span>
        ) : null}</>}
        activeId={activeDocument.id}
        icon={<span className="flex shrink-0 text-blue-600 dark:text-blue-400">{Icons.wordDocument(16)}</span>}
        label={t('word.documentTabs')}
        newLabel={t('word.newDocument')}
        onClose={(documentId) => {
          setTabError(null)
          flushActiveSnapshot()
          if (!onClose) {
            void store.dispatch({ type: 'document.close', documentId }).then((result) => {
              if (!result.ok) setTabError(result.error.message)
            }).catch((error) => setTabError(error instanceof Error ? error.message : String(error)))
            return
          }
          void store.closeDocumentTab(documentId).then((result) => {
            if (!result.ok) setTabError(result.error.message)
            else if (result.value.closeSurface) onClose()
          }).catch((error) => setTabError(error instanceof Error ? error.message : String(error)))
        }}
        onCreate={() => { flushActiveSnapshot(); void store.dispatch({ type: 'document.create' }) }}
        onSelect={(documentId) => { flushActiveSnapshot(); void store.dispatch({ type: 'document.activate', documentId }) }}
        tabs={workspace.documents.map((item) => {
          const title = item.sourcePath?.split(/[\\/]/).at(-1) || item.title.trim() || t('word.untitled')
          const fileName = title.toLocaleLowerCase().endsWith('.docx') ? title : `${title}.docx`
          return { id: item.id, label: fileName, closeLabel: t('word.closeDocument', { title: fileName }), dirtyLabel: isWordDocumentDirty(item) ? t('office.unsaved') : undefined }
        })}
        testIdPrefix="word"
      />

      {saveError ? <div role="alert" className="px-3 py-2 text-sm text-status-error">{saveError}</div> : null}
      {operationError || tabError ? <div role="alert" className="px-3 py-2 text-sm text-status-error">{operationError ?? tabError}</div> : null}
      {persistenceStatus === 'error' || checkpointError ? <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-status-error" role="alert">
        <span>{checkpointError ?? t('word.persistence.error')}</span>
        <button className="shrink-0 rounded px-2 py-1 hover:bg-status-error/10 disabled:opacity-50" disabled={saving} onClick={retryCheckpoint} type="button">{t('office.retry')}</button>
      </div> : null}
      {imageError ? <div role="alert" className="px-3 py-2 text-sm text-status-error">{imageError}</div> : null}
      {activeDocument.sourceProtected ? <div className="px-3 py-2 text-xs text-text-secondary" role="status">{t('office.importedCopyNotice')}</div> : null}
      <WordRibbon
        activeTab={activeRibbonTab}
        onActiveTabChange={setActiveRibbonTab}
        onCommand={runEditingCommand}
        onEditFooter={() => editHeaderFooter('footerHtml')}
        onEditHeader={() => editHeaderFooter('headerHtml')}
        onInlineStyle={(property, value) => {
          if (property === 'line-height') void store.dispatch({ type: 'editor.format', action: 'lineHeight', value })
          if (property === 'letter-spacing') void store.dispatch({ type: 'editor.format', action: 'letterSpacing', value })
        }}
        onInsertCaption={insertCaption}
        onInsertCitation={insertCitation}
        onInsertFootnote={insertFootnote}
        onInsertHtml={insertHtml}
        onInsertImage={() => imageInputRef.current?.click()}
        onInsertLink={insertLink}
        onInsertPageBreak={() => { void store.dispatch({ type: 'editor.insert', kind: 'pageBreak' }) }}
        onInsertTable={() => { void store.dispatch({ type: 'editor.insert', kind: 'table', rows: 3, cols: 3, withHeaderRow: true }) }}
        onInsertTableOfContents={insertTableOfContents}
        onPageChange={(page) => { flushActiveSnapshot(); void store.dispatch({ type: 'document.page.update', documentId: activeDocument.id, page }) }}
        onTableAction={(action: WordTableAction) => { void store.dispatch({ type: 'editor.table', action }) }}
        onToggleRibbon={() => setRibbonCollapsed((collapsed) => !collapsed)}
        onToggleRuler={() => setRulerVisible((visible) => !visible)}
        onZoomChange={changeZoom}
        page={activeDocument.page}
        ribbonCollapsed={ribbonCollapsed}
        rulerVisible={rulerVisible}
        tableActive={tableActive}
        zoom={zoom}
      />

      {editingHeaderFooter ? <WordHeaderFooterDialog
        draft={editingHeaderFooter}
        title={t(editingHeaderFooter.field === 'headerHtml' ? 'word.header' : 'word.footer')}
        onClose={() => setEditingHeaderFooter(null)}
        onSave={async (snapshot) => {
          const { documentId } = editingHeaderFooter
          const current = store.getSnapshot().documents.find((document) => document.id === documentId)
          if (!current) throw new Error(t('word.headerFooterUnavailable'))
          const merged = mergeWordHeaderFooterDraft(current.snapshot, editingHeaderFooter, snapshot)
          if (!store.commitEditorSnapshot(documentId, merged)) throw new Error(t('word.headerFooterUnavailable'))
        }}
      /> : null}

      <input accept="image/png,image/jpeg,image/gif,image/bmp,image/webp" className="sr-only" onChange={handleImageChange} ref={imageInputRef} type="file" />
      {rulerVisible ? <WordRuler page={activeDocument.page} zoom={zoom} /> : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#eef0f4] dark:bg-[#20201e]" data-testid="word-canvas" ref={canvasRef}>
        {workspace.documents.map((document) => <UniverDocumentSurface
          active={document.id === activeDocument.id}
          documentId={document.id}
          editorLabel={t('word.coreEditor')}
          errorLabel={t('word.coreError')}
          language={i18n.language}
          key={document.id}
          onRuntimeChange={setEditorRuntime}
          onTableActiveChange={setEditorTableActive}
          snapshot={document.snapshot}
          onFlushHandlerChange={setEditorFlush}
          store={store}
          zoom={zoom}
        />)}
      </div>

      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border-subtle bg-bg-surface px-3 text-2xs text-text-tertiary">
        <div className="flex items-center gap-4"><span>{t('word.documentCount', { n: workspace.documents.length })}</span><span>{t('word.pageCount', { n: pageCount })}</span><span>{t('word.wordCount', { n: wordCount })}</span></div>
        <div className="flex items-center gap-1"><FooterButton label={t('word.zoomOut')} onClick={() => changeZoom(Math.max(50, zoom - 10))}><ZoomOut className="size-3.5" /></FooterButton><Tooltip content={t('word.fitWidth')} delayMs={0}><button aria-label={t('word.fitWidth')} className={cn('min-w-10 rounded px-1 text-center hover:bg-bg-hover', zoomMode === 'fit' && 'text-text-secondary')} data-zoom-mode={zoomMode} onClick={fitPageWidth} type="button">{zoom}%</button></Tooltip><FooterButton label={t('word.zoomIn')} onClick={() => changeZoom(Math.min(200, zoom + 10))}><ZoomIn className="size-3.5" /></FooterButton></div>
      </footer>
    </section>
  )
}

function WordRuler({ page, zoom }: { page: WordPageSettings; zoom: number }) {
  const { t } = useTranslation()
  const marks = Array.from({ length: 19 }, (_, index) => index)
  return (
    <div aria-label={t('word.ruler')} className="h-5 shrink-0 overflow-hidden border-b border-border-subtle bg-[#eef0f4] px-4 dark:bg-[#20201e]" data-testid="word-ruler">
      <div
        className="relative mx-auto h-full max-w-full border-x border-border-default bg-bg-surface text-[8px] text-text-tertiary"
        style={{ width: `${getWordPageWidth(page) * (zoom / 100)}px` }}
      >
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between">
          {marks.map((mark) => (
            <span className="relative h-2 border-l border-border-default" key={mark}>
              <span className="absolute bottom-1.5 left-1 -translate-x-1/2">{mark}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function UniverDocumentSurface({ active, documentId, editorLabel, errorLabel, language, onFlushHandlerChange, onRuntimeChange, onTableActiveChange, snapshot, store, zoom }: {
  active: boolean
  documentId: string
  editorLabel: string
  errorLabel: string
  language: string
  onFlushHandlerChange?: (flush: (() => Promise<void>) | null, documentId: string) => void
  onRuntimeChange: (runtime: WordEditorRuntime | null, documentId: string) => void
  onTableActiveChange: (active: boolean, documentId: string) => void
  snapshot: IDocumentData
  store: WordDomainStore
  zoom: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<ReturnType<typeof createWordEditorAdapter> | null>(null)
  const snapshotRef = useRef(snapshot)
  const zoomRef = useRef(zoom)
  const languageRef = useRef(language)
  const [initializationError, setInitializationError] = useState(false)

  useLayoutEffect(() => { snapshotRef.current = snapshot }, [snapshot])
  useLayoutEffect(() => { zoomRef.current = zoom; adapterRef.current?.setZoom(zoom) }, [zoom])
  useLayoutEffect(() => { languageRef.current = language; adapterRef.current?.setLanguage(language) }, [language])

  useEffect(() => {
    if (!active || adapterRef.current) return
    const container = hostRef.current
    if (!container || !canvasIsAvailable()) return
    const initializationTimer = setTimeout(() => {
      try {
        const adapter = createWordEditorAdapter({
          active: true,
          container,
          documentId,
          language: languageRef.current,
          onTableActiveChange: (value) => onTableActiveChange(value, documentId),
          snapshot: snapshotRef.current,
          store,
          zoom: zoomRef.current,
        })
        adapterRef.current = adapter
        onRuntimeChange(adapter.runtime, documentId)
        onFlushHandlerChange?.(adapter.flush, documentId)
        setInitializationError(false)
      } catch {
        setInitializationError(true)
        onRuntimeChange(null, documentId)
      }
    }, 0)
    return () => { clearTimeout(initializationTimer) }
  }, [active, documentId, onFlushHandlerChange, onRuntimeChange, onTableActiveChange, store])

  useLayoutEffect(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    adapter.setActive(active)
    onRuntimeChange(active ? adapter.runtime : null, documentId)
    onFlushHandlerChange?.(active ? adapter.flush : null, documentId)
  }, [active, documentId, onFlushHandlerChange, onRuntimeChange])

  useEffect(() => () => {
      const adapter = adapterRef.current
      if (!adapter) return
      adapter.dispose()
      if (adapterRef.current === adapter) adapterRef.current = null
      onFlushHandlerChange?.(null, documentId)
      onRuntimeChange(null, documentId)
  }, [documentId, onFlushHandlerChange, onRuntimeChange, onTableActiveChange, store])

  useEffect(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    let cancelled = false
    void adapter.reconcile(snapshot).then((applied) => {
      if (!cancelled) setInitializationError(!applied)
    }).catch(() => { if (!cancelled) setInitializationError(true) })
    return () => { cancelled = true }
  }, [documentId, snapshot, store])

  return (
    <div {...(!active ? { inert: '' } : {})} aria-hidden={!active} className={cn('absolute inset-0', !active && 'invisible pointer-events-none')} data-word-document-id={documentId} data-word-active={active}>
      <div aria-label={editorLabel} className="word-univer-host size-full" data-testid={active ? 'word-editor' : undefined} ref={hostRef} />
      {initializationError ? <div className="absolute inset-0 grid place-items-center text-sm text-text-tertiary">{errorLabel}</div> : null}
    </div>
  )
}

function FooterButton({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return <Tooltip content={label} delayMs={0}><button aria-label={label} className="flex size-5 items-center justify-center rounded hover:bg-bg-hover hover:text-text-primary" onClick={onClick} type="button">{children}</button></Tooltip>
}

function canvasIsAvailable(): boolean {
  try {
    return Boolean(document.createElement('canvas').getContext?.('2d'))
  } catch {
    return false
  }
}

function createReferenceId(prefix: string): string {
  const suffix = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${suffix}`
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image.'))
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unable to read image.'))
    reader.readAsDataURL(file)
  })
}

function escapeHtml(value: string): string {
  const holder = document.createElement('span')
  holder.textContent = value
  return holder.innerHTML
}
