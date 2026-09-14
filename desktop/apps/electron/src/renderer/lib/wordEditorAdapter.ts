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
  dispose(): void
}

export interface WordEditorRuntime {
  documentId: string
  document: WordUniverDocumentFacade
  commit(): boolean
}

interface WordEditorMountOptions {
  container: HTMLElement
  language: string
  snapshot: IDocumentData
}

export interface WordEditorAdapterOptions extends WordEditorMountOptions {
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

/** Own one native Word document; React owns only its container and visible controls. */
export function createWordEditorAdapter(options: WordEditorAdapterOptions) {
  const { container, documentId, snapshot, store } = options
  let lastSnapshotSignature = snapshotSignature(snapshot)
  let lastDomainSignature = snapshotSignature(snapshot)
  let snapshotSyncQueue: Promise<void> = Promise.resolve()
  let commitTimer: ReturnType<typeof setTimeout> | null = null
  let focusTimer: ReturnType<typeof setTimeout> | null = null
  let activeSelection: WordUniverSelection | null = null
  let zoom = options.zoom
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
  const engine = (options.mountNative ?? mountWordUniverEngine)(options)
  const { document: nativeDocument, univerAPI } = engine
  const lease = binding.capture()
  lastSnapshotSignature = snapshotSignature(nativeDocument.getSnapshot())
  const currentDocument = () => store.getSnapshot().documents.find((item) => item.id === documentId)

  const commit = (): boolean => {
    if (!lease.isCurrent()) return false
    const current = currentDocument()
    // A new domain snapshot must reach native before native can publish edits over it.
    if (!current || snapshotSignature(current.snapshot) !== lastDomainSignature) return false
    const nextSnapshot = binding.readSnapshot()
    if (!nextSnapshot) return false
    const signature = snapshotSignature(nextSnapshot)
    if (signature === lastSnapshotSignature) return false
    if (!binding.publishChange(nextSnapshot, lease)) return false
    lastSnapshotSignature = signature
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
    if (!lease.isCurrent()) return
    const editorInput = container.querySelector<HTMLElement>('[data-u-comp="editor"]')
    const selectionBounds = editorInput?.parentElement?.parentElement?.getBoundingClientRect()
    const caretIsReady = window.document.activeElement === editorInput
      && selectionBounds !== undefined && selectionBounds.left > -1_000 && selectionBounds.top > -1_000
    if (caretIsReady) return
    await univerAPI.executeCommand(SetDocZoomRatioCommand.id, { documentId, zoomRatio: zoom / 100 }).catch(() => undefined)
    if (!lease.isCurrent()) return
    const activeElement = window.document.activeElement
    if (activeElement instanceof HTMLElement && !container.contains(activeElement)) activeElement.blur()
    const caretOffset = Math.max(0, (nativeDocument.getSnapshot().body?.dataStream.length ?? 2) - 2)
    nativeDocument.setSelection(caretOffset, caretOffset)
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
        const params = commandInfo.params as { ranges?: Array<Partial<WordUniverSelection> & { isActive?: boolean }> }
        const range = params.ranges?.find((item) => item.isActive) ?? params.ranges?.[0]
        if (typeof range?.startOffset === 'number' && typeof range.endOffset === 'number') {
          activeSelection = {
            startOffset: range.startOffset,
            endOffset: range.endOffset,
            ...(range.rangeType ? { rangeType: range.rangeType } : {}),
            ...(range.startNodePosition !== undefined ? { startNodePosition: range.startNodePosition } : {}),
          }
          options.onTableActiveChange?.(isUniverSelectionInsideTable(activeSelection))
        }
      }
      if (!shouldCommitUniverCommand(commandInfo.id)) return
      if (commitTimer) clearTimeout(commitTimer)
      commitTimer = setTimeout(() => { commitTimer = null; commit() }, 40)
    })

    unregisterCommandHandler = store.registerEditorCommandHandler(documentId, async (command, context) => {
      await binding.flush()
      context.assertCurrent()
      if (!lease.isCurrent()) return false
      const applied = await executeUniverWordCommand({
        document: nativeDocument,
        getSelection: () => activeSelection,
        unitId: documentId,
        univerAPI,
        onReferenceCommand: async (referenceCommand) => context.applyReferenceCommand(referenceCommand),
      } satisfies WordUniverCommandContext, command)
      if (!lease.isCurrent()) return false
      if (applied && command.type !== 'editor.reference.remove' && command.type !== 'editor.reference.update') commit()
      return applied
    }, binding.flush)
    options.onTableActiveChange?.(false)
    void focusInitialCaret()
  } catch (error) {
    binding.dispose()
    throw error
  }

  return {
    runtime: { documentId, document: nativeDocument, commit } satisfies WordEditorRuntime,
    reconcile: synchronize,
    flush: binding.flush,
    setLanguage(language: string) {
      if (lease.isCurrent()) univerAPI.setLocale(language.toLocaleLowerCase().startsWith('zh') ? LocaleType.ZH_CN : LocaleType.EN_US)
    },
    setZoom(nextZoom: number) {
      zoom = nextZoom
      if (lease.isCurrent()) void univerAPI.executeCommand(SetDocZoomRatioCommand.id, { documentId, zoomRatio: zoom / 100 }).catch(() => undefined)
    },
    dispose() {
      // The final synchronous native edit must be accepted before the lease is invalidated.
      try { commit() } finally { binding.dispose() }
    },
  }
}

function mountWordUniverEngine({ container, language, snapshot }: WordEditorMountOptions): WordEditorNativeEngine {
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
  try {
    return { document: univerAPI.createUniverDoc(snapshot), univerAPI, dispose: () => univer.dispose() }
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
