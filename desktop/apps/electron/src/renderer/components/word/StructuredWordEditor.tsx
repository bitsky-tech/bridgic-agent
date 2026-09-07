import {
  LocaleType,
  LogLevel,
  Univer,
  mergeLocales,
  type IDocumentData,
  type IUniverConfig,
  type Plugin,
  type PluginCtor,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverDocsCorePreset } from '@univerjs/preset-docs-core'
import docsCoreEnUS from '@univerjs/preset-docs-core/locales/en-US'
import docsCoreZhCN from '@univerjs/preset-docs-core/locales/zh-CN'
import { UniverDocsDrawingPreset } from '@univerjs/preset-docs-drawing'
import docsDrawingEnUS from '@univerjs/preset-docs-drawing/locales/en-US'
import docsDrawingZhCN from '@univerjs/preset-docs-drawing/locales/zh-CN'
import { UniverDocsHyperLinkPreset } from '@univerjs/preset-docs-hyper-link'
import docsHyperLinkEnUS from '@univerjs/preset-docs-hyper-link/locales/en-US'
import docsHyperLinkZhCN from '@univerjs/preset-docs-hyper-link/locales/zh-CN'
import { ReplaceSnapshotCommand, SetDocZoomRatioCommand } from '@univerjs/docs-ui'
import '@univerjs/preset-docs-core/lib/index.css'
import '@univerjs/preset-docs-drawing/lib/index.css'
import '@univerjs/preset-docs-hyper-link/lib/index.css'

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
import { FileText, Maximize2, Minimize2, Plus, Save, X, ZoomIn, ZoomOut } from 'lucide-react'

import { Tooltip } from '@/components/amphi/Tooltip'
import { cn } from '@/lib/cn'
import type {
  WordDomainStore,
  WordEditorCommand,
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
  snapshotSignature,
} from '@/lib/wordUniverModel'
import {
  executeUniverWordCommand,
  isUniverSelectionInsideTable,
  type WordUniverCommandContext,
  type WordUniverDocumentFacade,
  type WordUniverSelection,
} from '@/lib/wordUniverAdapter'

import { WordRibbon, type WordRibbonTab } from './WordRibbon'

export interface StructuredWordEditorProps {
  expanded: boolean
  onSaveRequested?: () => void
  onToggleExpanded: () => void
  persistenceStatus?: WordPersistenceStatus
  showExpandControl?: boolean
  store: WordDomainStore
}

interface UniverRuntime {
  documentId: string
  document: WordUniverDocumentFacade
  univerAPI: FUniver
}

interface OpenSourcePreset {
  plugins: Array<PluginCtor<Plugin> | [PluginCtor<Plugin>, ConstructorParameters<PluginCtor<Plugin>>[0]]>
}

interface UniverCommandExecutor {
  executeCommand(id: string, params?: object): Promise<boolean>
}

type WordZoomMode = 'fit' | 'manual'

const NON_PERSISTED_UNIVER_COMMAND_IDS = new Set([
  'doc.operation.set-selections',
  'univer.command.copy',
  ReplaceSnapshotCommand.id,
  SetDocZoomRatioCommand.id,
])

export function shouldCommitUniverCommand(commandId: string): boolean {
  return !NON_PERSISTED_UNIVER_COMMAND_IDS.has(commandId)
}

export async function replaceUniverSnapshotWithRetry(executor: UniverCommandExecutor, documentId: string, snapshot: IDocumentData, attempts = 2): Promise<boolean> {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      if (await executor.executeCommand(ReplaceSnapshotCommand.id, {
        unitId: documentId,
        snapshot,
        // Univer skips metadata-only snapshot changes when textRanges is truthy, including an empty array.
        textRanges: undefined,
        options: { noHistory: true },
      })) return true
    } catch {
      // Retry transient renderer command failures before surfacing the editor error state.
    }
  }
  return false
}

/** Univer OSS-backed Word frontend shared by the right dock and Session-owned renderer target. */
export function StructuredWordEditor({
  expanded,
  onSaveRequested = () => undefined,
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
  const [runtime, setRuntime] = useState<UniverRuntime | null>(null)

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
    if (runtime?.documentId === activeDocument.id) store.commitEditorSnapshot(activeDocument.id, runtime.document.getSnapshot())
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
    void readFileAsDataUrl(file)
      .then((src) => store.dispatch({ type: 'editor.insert', kind: 'image', src, alt: file.name, title: file.name }))
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
      <header className="flex h-10 shrink-0 items-end gap-1 border-b border-border-subtle bg-bg-app px-2" data-testid="word-document-header">
        <div aria-label={t('word.documentTabs')} className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-testid="word-document-tabs" role="tablist">
          {workspace.documents.map((item) => {
            const active = item.id === activeDocument.id
            const title = item.title.trim() || t('word.untitled')
            const fileName = title.toLocaleLowerCase().endsWith('.docx') ? title : `${title}.docx`
            return (
              <div className={cn('group flex h-8 min-w-[132px] max-w-56 shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11px]', active ? 'border-border-subtle bg-bg-surface text-text-primary' : 'border-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-secondary')} key={item.id}>
                <Tooltip content={fileName} delayMs={0}>
                  <button aria-selected={active} className="flex min-w-0 flex-1 items-center gap-1 text-left" data-testid="word-document-tab" onClick={() => { flushActiveSnapshot(); void store.dispatch({ type: 'document.activate', documentId: item.id }) }} role="tab" type="button">
                    <FileText className={cn('size-3 shrink-0', active ? 'text-blue-600' : 'text-text-tertiary')} />
                    <span className="truncate">{fileName}</span>
                  </button>
                </Tooltip>
                <Tooltip content={t('word.closeDocument', { title: fileName })} delayMs={0}>
                  <button aria-label={t('word.closeDocument', { title: fileName })} className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded opacity-50 hover:bg-black/10 hover:opacity-100" onClick={() => { flushActiveSnapshot(); void store.dispatch({ type: 'document.close', documentId: item.id }) }} type="button"><X className="size-[11px]" /></button>
                </Tooltip>
              </div>
            )
          })}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-1 pb-1">
          <HostButton label={t('word.newDocument')} onClick={() => { flushActiveSnapshot(); void store.dispatch({ type: 'document.create' }) }}><Plus className="size-[13px]" />{t('word.newDocument')}</HostButton>
          <HostButton label={t('word.save')} onClick={() => { flushActiveSnapshot(); onSaveRequested() }}><Save className="size-[13px]" />{t('word.save')}</HostButton>
          <span aria-live="polite" className={cn('ml-1 max-w-28 truncate text-[10px] text-text-tertiary', persistenceStatus === 'error' && 'text-status-error')}>
            {t(`word.persistence.${persistenceStatus}`)}
          </span>
          {showExpandControl ? <HeaderButton label={expanded ? t('word.exitExpanded') : t('word.expand')} onClick={onToggleExpanded} pressed={expanded} testId="word-expand-toggle">{expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</HeaderButton> : null}
        </div>
      </header>

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

function UniverDocumentSurface({ documentId, editorLabel, errorLabel, language, onRuntimeChange, onTableActiveChange, snapshot, store, zoom }: {
  documentId: string
  editorLabel: string
  errorLabel: string
  language: string
  onRuntimeChange: (runtime: UniverRuntime | null) => void
  onTableActiveChange: (active: boolean) => void
  snapshot: IDocumentData
  store: WordDomainStore
  zoom: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<UniverRuntime | null>(null)
  const lastSnapshotSignatureRef = useRef(snapshotSignature(snapshot))
  const snapshotSyncQueueRef = useRef<Promise<void>>(Promise.resolve())
  const snapshotRef = useRef(snapshot)
  const zoomRef = useRef(zoom)
  const [initializationError, setInitializationError] = useState(false)

  useEffect(() => { snapshotRef.current = snapshot }, [snapshot])
  useEffect(() => { zoomRef.current = zoom }, [zoom])

  useEffect(() => {
    const container = hostRef.current
    if (!container || !canvasIsAvailable()) return
    let disposed = false
    let commitTimer: ReturnType<typeof setTimeout> | null = null
    let commitEditorSnapshot: (() => void) | null = null
    let activeSelection: WordUniverSelection | null = null
    let disposeRuntime: (() => void) | null = null
    let focusTimer: ReturnType<typeof setTimeout> | null = null
    const initializationTimer = setTimeout(() => {
      if (disposed) return
      try {
        const locale = language.toLocaleLowerCase().startsWith('zh') ? LocaleType.ZH_CN : LocaleType.EN_US
        const { univer, univerAPI } = createOpenSourceUniver({
          locale,
          locales: {
            [LocaleType.ZH_CN]: mergeLocales(docsCoreZhCN, docsDrawingZhCN, docsHyperLinkZhCN),
            [LocaleType.EN_US]: mergeLocales(docsCoreEnUS, docsDrawingEnUS, docsHyperLinkEnUS),
          },
          presets: [
            UniverDocsCorePreset({ container, header: false, toolbar: false, footer: false, contextMenu: true }),
            UniverDocsDrawingPreset(),
            UniverDocsHyperLinkPreset(),
          ],
        })
        const document = univerAPI.createUniverDoc(snapshotRef.current)
        const runtime = { documentId, document, univerAPI }
        lastSnapshotSignatureRef.current = snapshotSignature(snapshotRef.current)
        snapshotSyncQueueRef.current = Promise.resolve()
        runtimeRef.current = runtime
        onRuntimeChange(runtime)
        onTableActiveChange(false)

        commitEditorSnapshot = () => {
          if (disposed) return
          const nextSnapshot = document.getSnapshot()
          const signature = snapshotSignature(nextSnapshot)
          if (signature === lastSnapshotSignatureRef.current) return
          lastSnapshotSignatureRef.current = signature
          store.commitEditorSnapshot(documentId, nextSnapshot)
        }

        const focusInitialCaret = async (attempt = 0) => {
          if (disposed) return
          const editorInput = container.querySelector<HTMLElement>('[data-u-comp="editor"]')
          const selectionLayer = editorInput?.parentElement?.parentElement
          const selectionBounds = selectionLayer?.getBoundingClientRect()
          const caretIsReady = window.document.activeElement === editorInput
            && selectionBounds !== undefined
            && selectionBounds.left > -1_000
            && selectionBounds.top > -1_000
          if (caretIsReady) return

          await univerAPI.executeCommand(SetDocZoomRatioCommand.id, { documentId, zoomRatio: zoomRef.current / 100 }).catch(() => undefined)
          if (disposed) return
          const activeElement = window.document.activeElement
          if (activeElement instanceof HTMLElement && !container.contains(activeElement)) activeElement.blur()
          const dataStreamLength = document.getSnapshot().body?.dataStream.length ?? 2
          const caretOffset = Math.max(0, dataStreamLength - 2)
          document.setSelection(caretOffset, caretOffset)
          if (attempt < 20) focusTimer = setTimeout(() => { void focusInitialCaret(attempt + 1) }, 50)
        }
        void focusInitialCaret()

        const commandSubscription = univerAPI.onCommandExecuted((commandInfo) => {
          if (commandInfo.id === 'doc.operation.set-selections') {
            const params = commandInfo.params as { ranges?: Array<Partial<WordUniverSelection> & { isActive?: boolean }> }
            const range = params.ranges?.find((item) => item.isActive) ?? params.ranges?.[0]
            if (typeof range?.startOffset === 'number' && typeof range.endOffset === 'number') {
              activeSelection = {
                startOffset: range.startOffset,
                endOffset: range.endOffset,
                ...(range.rangeType ? { rangeType: range.rangeType } : {}),
                ...(range.startNodePosition !== undefined ? { startNodePosition: range.startNodePosition } : {}),
              }
              onTableActiveChange(isUniverSelectionInsideTable(activeSelection))
            }
          }
          if (disposed || !shouldCommitUniverCommand(commandInfo.id)) return
          if (commitTimer) clearTimeout(commitTimer)
          commitTimer = setTimeout(() => commitEditorSnapshot?.(), 40)
        })

        const unregisterCommandHandler = store.registerEditorCommandHandler(async (command) => {
          const applied = await executeUniverWordCommand({
            document,
            getSelection: () => activeSelection,
            unitId: documentId,
            univerAPI,
            onReferenceCommand: (referenceCommand) => dispatchReferenceCommand(store, documentId, referenceCommand),
          } satisfies WordUniverCommandContext, command)
          if (applied && command.type !== 'editor.reference.remove' && command.type !== 'editor.reference.update') {
            commitEditorSnapshot?.()
          }
          return applied
        })

        disposeRuntime = () => {
          unregisterCommandHandler()
          commandSubscription.dispose()
          onRuntimeChange(null)
          onTableActiveChange(false)
          if (runtimeRef.current === runtime) runtimeRef.current = null
          // Univer owns a nested React root. Dispose it after the parent commit finishes.
          queueMicrotask(() => univer.dispose())
        }
      } catch {
        if (!disposed) setInitializationError(true)
        onRuntimeChange(null)
      }
    }, 0)

    return () => {
      clearTimeout(initializationTimer)
      if (focusTimer) clearTimeout(focusTimer)
      if (disposeRuntime) {
        if (commitTimer) clearTimeout(commitTimer)
        commitEditorSnapshot?.()
        disposeRuntime()
      }
      disposed = true
    }
  }, [documentId, language, onRuntimeChange, onTableActiveChange, store])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    const signature = snapshotSignature(snapshot)
    if (signature === lastSnapshotSignatureRef.current) return
    let cancelled = false
    const synchronize = async () => {
      const applied = await replaceUniverSnapshotWithRetry(runtime.univerAPI, documentId, snapshot)
      if (cancelled || runtimeRef.current !== runtime) return
      if (applied) {
        lastSnapshotSignatureRef.current = signature
        setInitializationError(false)
      } else {
        setInitializationError(true)
      }
    }
    snapshotSyncQueueRef.current = snapshotSyncQueueRef.current.then(synchronize, synchronize)
    return () => { cancelled = true }
  }, [documentId, snapshot])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    void runtime.univerAPI.executeCommand(SetDocZoomRatioCommand.id, { documentId, zoomRatio: zoom / 100 }).catch(() => undefined)
  }, [documentId, zoom])

  return (
    <div className="size-full">
      <div aria-label={editorLabel} className="word-univer-host size-full" data-testid="word-editor" ref={hostRef} />
      {initializationError ? <div className="absolute inset-0 grid place-items-center text-sm text-text-tertiary">{errorLabel}</div> : null}
    </div>
  )
}

/** Register only the explicitly supplied OSS presets, avoiding Univer's all-presets umbrella. */
function createOpenSourceUniver({ locale, locales, presets }: {
  locale: LocaleType
  locales: IUniverConfig['locales']
  presets: OpenSourcePreset[]
}) {
  const univer = new Univer({ locale, locales, logLevel: LogLevel.WARN })
  const registrations = new Map<string, OpenSourcePreset['plugins'][number]>()
  for (const preset of presets) {
    for (const registration of preset.plugins) {
      const plugin = Array.isArray(registration) ? registration[0] : registration
      if (registrations.has(plugin.pluginName)) registrations.delete(plugin.pluginName)
      registrations.set(plugin.pluginName, registration)
    }
  }
  for (const registration of registrations.values()) {
    if (Array.isArray(registration)) univer.registerPlugin(registration[0], registration[1])
    else univer.registerPlugin(registration)
  }
  return { univer, univerAPI: FUniver.newAPI(univer) }
}

async function dispatchReferenceCommand(store: WordDomainStore, documentId: string, command: Extract<WordEditorCommand, { type: 'editor.reference.remove' | 'editor.reference.update' }>): Promise<boolean> {
  if (command.type === 'editor.reference.remove') {
    const result = command.kind === 'footnote'
      ? await store.dispatch({ type: 'document.footnote.remove', documentId, footnoteId: command.id })
      : await store.dispatch({ type: 'document.citation.remove', documentId, citationId: command.id })
    return result.ok
  }
  if (command.kind === 'footnote') return (await store.dispatch({ type: 'document.footnote.update', documentId, footnoteId: command.id, text: command.text })).ok
  return (await store.dispatch({ type: 'document.citation.update', documentId, citationId: command.id, text: command.text })).ok
}

function HeaderButton({ children, label, onClick, pressed, testId }: { children: ReactNode; label: string; onClick: () => void; pressed?: boolean; testId?: string }) {
  return <Tooltip content={label} delayMs={0}><button aria-label={label} aria-pressed={pressed} className={cn('flex size-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary', pressed && 'bg-blue-500/10 text-blue-600')} data-testid={testId} onClick={onClick} type="button">{children}</button></Tooltip>
}

function HostButton({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return <Tooltip content={label} delayMs={0}><button aria-label={label} className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary" onClick={onClick} type="button">{children}</button></Tooltip>
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
