import type { IDocumentData } from '@univerjs/core'

import {
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
  WordHeaderFooterSettings,
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

export { replaceUniverSnapshotWithRetry, shouldCommitUniverCommand } from '@/lib/wordEditorAdapter'

import { WordRibbon, type WordRibbonTab } from './WordRibbon'

export interface StructuredWordEditorProps {
  expanded: boolean
  onClose?: () => void
  onSaveRequested?: () => void
  onFlushHandlerChange?: (flush: (() => Promise<void>) | null) => void
  onToggleExpanded: () => void
  persistenceStatus?: WordPersistenceStatus
  showExpandControl?: boolean
  store: WordDomainStore
}

type WordZoomMode = 'fit' | 'manual'

/** Univer OSS-backed Word frontend shared by the right dock and Session-owned renderer target. */
export function StructuredWordEditor({
  expanded,
  onClose,
  onSaveRequested = () => undefined,
  onFlushHandlerChange,
  onToggleExpanded,
  persistenceStatus = 'saved',
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
    void readFileAsDataUrl(file)
      .then((src) => store.dispatch({ type: 'editor.insert', documentId, kind: 'image', src, alt: file.name, title: file.name }))
      .catch(() => undefined)
  }

  const updateHeaderFooter = (settings: Partial<WordHeaderFooterSettings>) => {
    flushActiveSnapshot()
    void store.dispatch({ type: 'document.headerFooter.update', documentId: activeDocument.id, settings })
  }

  const promptHeaderFooter = (field: 'headerHtml' | 'footerHtml') => {
    const current = stripHtml(activeDocument.headerFooter[field])
    const label = field === 'headerHtml' ? t('word.headerPrompt') : t('word.footerPrompt')
    const value = window.prompt(label, current)
    if (value !== null) updateHeaderFooter({ [field]: escapeHtml(value.trim()) })
  }

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
          onClose={onClose ? () => { flushActiveSnapshot(); onSaveRequested(); onClose() } : undefined}
          onToggleExpanded={showExpandControl ? onToggleExpanded : undefined}
          testIdPrefix="word"
          toggleTestId="word-expand-toggle"
        />
      </OfficeAppHeader>
      <OfficeDocumentTabs
        actions={persistenceStatus === 'error' ? (
          <span className="max-w-28 truncate text-[10px] text-status-error" role="alert">
            {t('word.persistence.error')}
          </span>
        ) : undefined}
        activeId={activeDocument.id}
        icon={<span className="flex shrink-0 text-blue-600 dark:text-blue-400">{Icons.wordDocument(16)}</span>}
        label={t('word.documentTabs')}
        newLabel={t('word.newDocument')}
        onClose={(documentId) => { flushActiveSnapshot(); void store.dispatch({ type: 'document.close', documentId }) }}
        onCreate={() => { flushActiveSnapshot(); void store.dispatch({ type: 'document.create' }) }}
        onSelect={(documentId) => { flushActiveSnapshot(); void store.dispatch({ type: 'document.activate', documentId }) }}
        tabs={workspace.documents.map((item) => {
          const title = item.title.trim() || t('word.untitled')
          const fileName = title.toLocaleLowerCase().endsWith('.docx') ? title : `${title}.docx`
          return { id: item.id, label: fileName, closeLabel: t('word.closeDocument', { title: fileName }) }
        })}
        testIdPrefix="word"
      />

      <WordRibbon
        activeTab={activeRibbonTab}
        onActiveTabChange={setActiveRibbonTab}
        onCommand={runEditingCommand}
        onEditFooter={() => promptHeaderFooter('footerHtml')}
        onEditHeader={() => promptHeaderFooter('headerHtml')}
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

      <input accept="image/*" className="sr-only" onChange={handleImageChange} ref={imageInputRef} type="file" />
      {rulerVisible ? <WordRuler page={activeDocument.page} zoom={zoom} /> : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#eef0f4] dark:bg-[#20201e]" data-testid="word-canvas" ref={canvasRef}>
        <UniverDocumentSurface
          documentId={activeDocument.id}
          editorLabel={t('word.coreEditor')}
          errorLabel={t('word.coreError')}
          language={i18n.language}
          onRuntimeChange={setRuntime}
          onTableActiveChange={setTableActive}
          snapshot={activeDocument.snapshot}
          onFlushHandlerChange={onFlushHandlerChange}
          store={store}
          zoom={zoom}
        />
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

function UniverDocumentSurface({ documentId, editorLabel, errorLabel, language, onFlushHandlerChange, onRuntimeChange, onTableActiveChange, snapshot, store, zoom }: {
  documentId: string
  editorLabel: string
  errorLabel: string
  language: string
  onFlushHandlerChange?: (flush: (() => Promise<void>) | null) => void
  onRuntimeChange: (runtime: WordEditorRuntime | null) => void
  onTableActiveChange: (active: boolean) => void
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
    const container = hostRef.current
    if (!container || !canvasIsAvailable()) return
    let adapter: ReturnType<typeof createWordEditorAdapter> | null = null
    const initializationTimer = setTimeout(() => {
      try {
        adapter = createWordEditorAdapter({
          container,
          documentId,
          language: languageRef.current,
          onTableActiveChange,
          snapshot: snapshotRef.current,
          store,
          zoom: zoomRef.current,
        })
        adapterRef.current = adapter
        onRuntimeChange(adapter.runtime)
        onFlushHandlerChange?.(adapter.flush)
        setInitializationError(false)
      } catch {
        adapter?.dispose()
        setInitializationError(true)
        onRuntimeChange(null)
      }
    }, 0)
    return () => {
      clearTimeout(initializationTimer)
      if (!adapter) return
      adapter.dispose()
      if (adapterRef.current === adapter) adapterRef.current = null
      onFlushHandlerChange?.(null)
      onRuntimeChange(null)
    }
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
    <div className="size-full">
      <div aria-label={editorLabel} className="word-univer-host size-full" data-testid="word-editor" ref={hostRef} />
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

function stripHtml(value: string): string {
  const template = document.createElement('template')
  template.innerHTML = value
  return template.content.textContent ?? ''
}

function escapeHtml(value: string): string {
  const holder = document.createElement('span')
  holder.textContent = value
  return holder.innerHTML
}
