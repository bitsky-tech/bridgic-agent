import {
  EDITOR_ACTIVATED,
  FOCUSING_COMMON_DRAWINGS,
  FOCUSING_DOC,
  FOCUSING_EDITOR_STANDALONE,
  FOCUSING_UNIVER_EDITOR,
  ICommandService,
  IContextService,
  IUniverInstanceService,
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
import { DocSelectionManagerService, SetTextSelectionsOperation } from '@univerjs/docs'
import { ICanvasPopupService, IContextMenuService, IDialogService } from '@univerjs/ui'
import { UniverDocsCorePreset } from '@univerjs/preset-docs-core'
import docsCoreEnUS from '@univerjs/preset-docs-core/locales/en-US'
import docsCoreZhCN from '@univerjs/preset-docs-core/locales/zh-CN'
import { UniverDocsDrawingPreset } from '@univerjs/preset-docs-drawing'
import docsDrawingEnUS from '@univerjs/preset-docs-drawing/locales/en-US'
import docsDrawingZhCN from '@univerjs/preset-docs-drawing/locales/zh-CN'
import { UniverDocsHyperLinkPreset } from '@univerjs/preset-docs-hyper-link'
import docsHyperLinkEnUS from '@univerjs/preset-docs-hyper-link/locales/en-US'
import docsHyperLinkZhCN from '@univerjs/preset-docs-hyper-link/locales/zh-CN'
import { ReplaceSnapshotCommand, SetDocZoomRatioCommand, SetDocZoomRatioOperation } from '@univerjs/docs-ui'
import '@univerjs/preset-docs-core/lib/index.css'
import '@univerjs/preset-docs-drawing/lib/index.css'
import '@univerjs/preset-docs-hyper-link/lib/index.css'


import type { WordDomainStore } from './wordDomain'
import { snapshotSignature } from './wordUniverModel'
import {
  executeUniverWordCommand,
  isUniverSelectionInsideTable,
  type WordUniverCommandContext,
  type WordUniverDocumentFacade,
  type WordUniverSelection,
} from './wordUniverAdapter'
import { createOfficeEditorBinding, type OfficeEditorLease } from './office/officeEditorBinding'

export interface WordEditorNativeEngine {
  document: WordUniverDocumentFacade
  univerAPI: Pick<FUniver, 'executeCommand' | 'setLocale' | 'onCommandExecuted'>
  setActive?(active: boolean): void
  dispose(): void
}

export interface WordEditorRuntime {
  documentId: string
  document: WordUniverDocumentFacade
  commit(): boolean
}

export interface WordEditorMountOptions {
  container: HTMLElement
  language: string
  snapshot: IDocumentData
  toolbar?: boolean
}

export interface WordEditorAdapterOptions extends WordEditorMountOptions {
  active?: boolean
  documentId: string
  store: WordDomainStore
  zoom: number
  onTableActiveChange?: (active: boolean) => void
  mountNative?: (options: WordEditorMountOptions) => WordEditorNativeEngine
}

interface OpenSourcePreset {
  plugins: Array<PluginCtor<Plugin> | [PluginCtor<Plugin>, ConstructorParameters<PluginCtor<Plugin>>[0]]>
}

interface UniverCommandExecutor {
  executeCommand(id: string, params?: object): Promise<boolean>
}

const NON_PERSISTED_UNIVER_COMMAND_IDS = new Set([
  'doc.operation.set-selections',
  'univer.command.copy',
  ReplaceSnapshotCommand.id,
  SetDocZoomRatioCommand.id,
])

export function shouldCommitUniverCommand(commandId: string): boolean {
  return !NON_PERSISTED_UNIVER_COMMAND_IDS.has(commandId)
    && !commandId.includes('.operation.')
    && (commandId.startsWith('doc.command') || commandId.startsWith('doc.mutation')
      || commandId.startsWith('drawing.command') || commandId.startsWith('drawing.mutation')
      || commandId === 'univer.command.undo' || commandId === 'univer.command.redo')
}

export async function replaceUniverSnapshotWithRetry(executor: UniverCommandExecutor, documentId: string, snapshot: IDocumentData, attempts = 2): Promise<boolean> {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      if (await executor.executeCommand(ReplaceSnapshotCommand.id, {
        unitId: documentId,
        snapshot: structuredClone(snapshot),
        // Univer skips metadata-only snapshot changes when textRanges is truthy, including an empty array.
        textRanges: undefined,
        // Accepted domain edits enter the same native undo history as typing.
        // Univer reads noHistory on the mutation, not inside selection options.
      })) return true
    } catch {
      // Retry transient renderer command failures before surfacing the editor error state.
    }
  }
  return false
}

/** Own one native Word document; React owns only its container and visible controls. */
export function createWordEditorAdapter(options: WordEditorAdapterOptions) {
  const { container, documentId, snapshot, store } = options
  let lastSnapshotSignature = snapshotSignature(snapshot)
  let lastDomainSignature = snapshotSignature(snapshot)
  let snapshotSyncQueue: Promise<void> = Promise.resolve()
  let commitTimer: ReturnType<typeof setTimeout> | null = null
  let focusTimer: ReturnType<typeof setTimeout> | null = null
  let activeSelection: WordUniverSelection | null = null
  let activeSelectionSegmentId = ''
  let zoom = options.zoom
  let contentChanged = false
  let active = options.active ?? true
  const binding = createOfficeEditorBinding<IDocumentData>({
    appKind: 'word',
    sessionId: store.getSnapshot().sessionId,
    documentId,
    onChange: (nextSnapshot) => {
      store.commitEditorSnapshot(documentId, nextSnapshot)
      const committed = store.getSnapshot().documents.find((item) => item.id === documentId)
      if (committed) lastDomainSignature = snapshotSignature(committed.snapshot)
    },
  })
  // Univer mutates drawing maps in place; native edits must pass through commit().
  const nativeSnapshot = structuredClone(snapshot)
  // Canonical custom ranges own link URLs. A stale plugin cache must not replace
  // newly edited links when the document mounts again.
  if (nativeSnapshot.resources) nativeSnapshot.resources = nativeSnapshot.resources.filter((resource) => resource.name !== 'DOC_HYPER_LINK_PLUGIN')
  const engine = (options.mountNative ?? mountWordUniverEngine)({ ...options, snapshot: nativeSnapshot })
  const { document: nativeDocument, univerAPI } = engine
  const lease = binding.capture()
  lastSnapshotSignature = snapshotSignature(nativeDocument.getSnapshot())
  const currentDocument = () => store.getSnapshot().documents.find((item) => item.id === documentId)
  const clampSavedBodySelection = (): boolean => {
    if (!activeSelection || activeSelectionSegmentId) return false
    const endOffset = Math.max(0, (nativeDocument.getSnapshot().body?.dataStream.length ?? 2) - 2)
    const start = Math.min(endOffset, Math.max(0, activeSelection.startOffset))
    const end = Math.min(endOffset, Math.max(0, activeSelection.endOffset))
    if (start === activeSelection.startOffset && end === activeSelection.endOffset) return false
    // A replacement can shorten the body and invalidate cached node positions.
    activeSelection = { startOffset: start, endOffset: end }
    return true
  }

  const commit = (): boolean => {
    if (!lease.isCurrent()) return false
    const current = currentDocument()
    // A new domain snapshot must reach native before native can publish edits over it.
    if (!current || snapshotSignature(current.snapshot) !== lastDomainSignature) return false
    const nextSnapshot = binding.readSnapshot()
    if (!nextSnapshot) return false
    const signature = snapshotSignature(nextSnapshot)
    if (signature === lastSnapshotSignature) return false
    if (!contentChanged) { lastSnapshotSignature = signature; return false }
    if (!binding.publishChange(nextSnapshot, lease)) return false
    lastSnapshotSignature = signature
    contentChanged = false
    return true
  }

  const synchronize = (requestedSnapshot?: IDocumentData): Promise<boolean> => {
    const operation = async () => {
      if (!lease.isCurrent()) return false
      const latest = currentDocument()
      if (!latest || (requestedSnapshot && latest.snapshot !== requestedSnapshot)) return false
      const signature = snapshotSignature(latest.snapshot)
      if (signature === lastDomainSignature) return true
      const applied = await replaceUniverSnapshotWithRetry(univerAPI, documentId, latest.snapshot)
      if (!applied || !lease.isCurrent()) return false
      if (currentDocument()?.snapshot !== latest.snapshot) return false
      lastSnapshotSignature = snapshotSignature(nativeDocument.getSnapshot())
      lastDomainSignature = signature
      contentChanged = false
      if (clampSavedBodySelection() && active && store.getSnapshot().activeDocumentId === documentId) {
        nativeDocument.setSelection(activeSelection!.startOffset, activeSelection!.endOffset)
      }
      return true
    }
    const pending = snapshotSyncQueue.then(operation, operation)
    snapshotSyncQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  const flushNativeSnapshot = async (currentLease: OfficeEditorLease) => {
    currentLease.assertCurrent()
    if (!await synchronize()) throw new Error('The Word editor could not synchronize its document.')
    currentLease.assertCurrent()
    if (commitTimer) clearTimeout(commitTimer)
    commitTimer = null
    commit()
  }

  const focusInitialCaret = async (attempt = 0) => {
    if (!active || !lease.isCurrent() || store.getSnapshot().activeDocumentId !== documentId) return
    const editorInput = container.querySelector<HTMLElement>('[data-u-comp="editor"]')
    const selectionBounds = editorInput?.parentElement?.parentElement?.getBoundingClientRect()
    const caretIsReady = window.document.activeElement === editorInput
      && selectionBounds !== undefined && selectionBounds.left > -1_000 && selectionBounds.top > -1_000
    if (caretIsReady) return
    await univerAPI.executeCommand(SetDocZoomRatioOperation.id, { unitId: documentId, zoomRatio: zoom / 100 }).catch(() => undefined)
    if (!active || !lease.isCurrent() || store.getSnapshot().activeDocumentId !== documentId) return
    const activeElement = window.document.activeElement
    if (activeElement instanceof HTMLElement && !container.contains(activeElement)) activeElement.blur()
    clampSavedBodySelection()
    const caretOffset = Math.max(0, (nativeDocument.getSnapshot().body?.dataStream.length ?? 2) - 2)
    nativeDocument.setSelection(activeSelection?.startOffset ?? caretOffset, activeSelection?.endOffset ?? caretOffset)
    if (attempt < 20) focusTimer = setTimeout(() => { void focusInitialCaret(attempt + 1) }, 50)
  }

  let commandSubscription: { dispose(): void } | null = null
  let unregisterCommandHandler: (() => void) | null = null
  binding.attach({
    readSnapshot: () => nativeDocument.getSnapshot(),
    flush: flushNativeSnapshot,
    dispose: () => {
      if (commitTimer) clearTimeout(commitTimer)
      if (focusTimer) clearTimeout(focusTimer)
      commitTimer = null
      focusTimer = null
      try {
        unregisterCommandHandler?.()
      } finally {
        try {
          commandSubscription?.dispose()
        } finally {
          // Univer owns a nested React root. Dispose it after the parent commit finishes.
          queueMicrotask(() => engine.dispose())
          options.onTableActiveChange?.(false)
        }
      }
    },
  })
  try {
    commandSubscription = univerAPI.onCommandExecuted((commandInfo) => {
      if (!lease.isCurrent()) return
      if (commandInfo.id === 'doc.operation.set-selections') {
        const params = commandInfo.params as { segmentId?: string; ranges?: Array<Partial<WordUniverSelection> & { isActive?: boolean }> }
        const range = params.ranges?.find((item) => item.isActive) ?? params.ranges?.[0]
        if (typeof range?.startOffset === 'number' && typeof range.endOffset === 'number') {
          activeSelectionSegmentId = params.segmentId ?? ''
          activeSelection = {
            startOffset: range.startOffset,
            endOffset: range.endOffset,
            ...(range.rangeType ? { rangeType: range.rangeType } : {}),
            ...(range.startNodePosition !== undefined ? { startNodePosition: range.startNodePosition } : {}),
          }
          if (active) options.onTableActiveChange?.(isUniverSelectionInsideTable(activeSelection))
        }
      }
      if (!shouldCommitUniverCommand(commandInfo.id)) return
      contentChanged = true
      if (commitTimer) clearTimeout(commitTimer)
      commitTimer = setTimeout(() => { commitTimer = null; commit() }, 40)
    })

    const handleCommand: Parameters<WordDomainStore['registerEditorCommandHandler']>[1] = async (command, context) => {
      await binding.flush()
      context.assertCurrent()
      if (!active || !lease.isCurrent()) return false
      const applied = await executeUniverWordCommand({
        document: nativeDocument,
        getSelection: () => activeSelection,
        unitId: documentId,
        univerAPI,
        onReferenceCommand: async (referenceCommand) => context.applyReferenceCommand(referenceCommand),
      } satisfies WordUniverCommandContext, command)
      if (!active || !lease.isCurrent()) return false
      if (applied && command.type !== 'editor.reference.remove' && command.type !== 'editor.reference.update') { contentChanged = true; commit() }
      return applied
    }
    const activate = () => {
      engine.setActive?.(true)
      unregisterCommandHandler = store.registerEditorCommandHandler(documentId, handleCommand, binding.flush)
      options.onTableActiveChange?.(activeSelection ? isUniverSelectionInsideTable(activeSelection) : false)
      void focusInitialCaret()
    }
    if (active) activate()
    else engine.setActive?.(false)

    return {
      runtime: { documentId, document: nativeDocument, commit } satisfies WordEditorRuntime,
      reconcile: synchronize,
      flush: binding.flush,
      setActive(nextActive: boolean) {
        if (!lease.isCurrent() || active === nextActive) return
        if (!nextActive) {
          commit()
          active = false
          if (focusTimer) clearTimeout(focusTimer)
          focusTimer = null
          unregisterCommandHandler?.()
          unregisterCommandHandler = null
          engine.setActive?.(false)
          options.onTableActiveChange?.(false)
        } else {
          active = true
          activate()
        }
      },
      setLanguage(language: string) {
        if (lease.isCurrent()) univerAPI.setLocale(language.toLocaleLowerCase().startsWith('zh') ? LocaleType.ZH_CN : LocaleType.EN_US)
      },
      setZoom(nextZoom: number) {
        zoom = nextZoom
        if (lease.isCurrent()) void univerAPI.executeCommand(SetDocZoomRatioOperation.id, { unitId: documentId, zoomRatio: zoom / 100 }).catch(() => undefined)
      },
      dispose() {
        // The final synchronous native edit must be accepted before the lease is invalidated.
        try { commit() } finally { binding.dispose() }
      },
    }
  } catch (error) {
    binding.dispose()
    throw error
  }

}

export function mountWordUniverEngine({ container, language, snapshot, toolbar = false }: WordEditorMountOptions): WordEditorNativeEngine {
  // The drawing plugin loads its resource, not just the document's drawing fields.
  snapshot.resources = [...(snapshot.resources ?? []).filter((resource) => resource.name !== 'DOC_DRAWING_PLUGIN' && resource.name !== 'DOC_HYPER_LINK_PLUGIN'), {
    name: 'DOC_DRAWING_PLUGIN', data: JSON.stringify({ data: snapshot.drawings ?? {}, order: snapshot.drawingsOrder ?? [] }),
  }]
  const locale = language.toLocaleLowerCase().startsWith('zh') ? LocaleType.ZH_CN : LocaleType.EN_US
  const { univer, univerAPI } = createOpenSourceUniver({
    locale,
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(docsCoreZhCN, docsDrawingZhCN, docsHyperLinkZhCN),
      [LocaleType.EN_US]: mergeLocales(docsCoreEnUS, docsDrawingEnUS, docsHyperLinkEnUS),
    },
    presets: [
      UniverDocsCorePreset({ container, header: toolbar, toolbar, footer: false, contextMenu: true }),
      UniverDocsDrawingPreset(),
      UniverDocsHyperLinkPreset(),
    ],
  })
  try {
    const document = univerAPI.createUniverDoc(snapshot)
    const injector = univer.__getInjector()
    const instances = injector.get(IUniverInstanceService)
    const context = injector.get(IContextService)
    const commands = injector.get(ICommandService)
    const selections = injector.get(DocSelectionManagerService)
    const popups = injector.get(ICanvasPopupService)
    const contextMenus = injector.get(IContextMenuService)
    const dialogs = injector.get(IDialogService)
    return {
      document,
      univerAPI,
      setActive(active) {
        if (!active) {
          // Clear both rendered ranges and the manager's cache so zoom/resize cannot
          // restore an inactive selection. The adapter retains its own caret for activation.
          selections.replaceDocRanges([], { unitId: snapshot.id, subUnitId: snapshot.id }, false, { shouldFocus: false })
          // Also reset popup caches before the native renderer has finished mounting.
          // Floating views live outside the retained document's hidden container.
          commands.syncExecuteCommand(SetTextSelectionsOperation.id, { unitId: snapshot.id, subUnitId: snapshot.id, segmentId: '', ranges: [], isEditing: false })
          popups.removeAll()
          contextMenus.hideContextMenu()
          dialogs.closeAll()
          const focused = window.document.activeElement
          if (focused instanceof HTMLElement && container.contains(focused)) focused.blur()
          for (const key of [EDITOR_ACTIVATED, FOCUSING_COMMON_DRAWINGS, FOCUSING_EDITOR_STANDALONE, FOCUSING_UNIVER_EDITOR]) context.setContextValue(key, false)
        }
        instances.focusUnit(active ? snapshot.id : null)
        context.setContextValue(FOCUSING_DOC, active)
      },
      dispose: () => univer.dispose(),
    }
  } catch (error) {
    univer.dispose()
    throw error
  }
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
  try {
    for (const registration of registrations.values()) {
      if (Array.isArray(registration)) univer.registerPlugin(registration[0], registration[1])
      else univer.registerPlugin(registration)
    }
    return { univer, univerAPI: FUniver.newAPI(univer) }
  } catch (error) {
    univer.dispose()
    throw error
  }
}
