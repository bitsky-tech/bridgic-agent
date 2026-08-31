import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents,
} from 'electron'
import type {
  ExcelDocumentHandle,
  ExcelOpenResult,
  ExcelSaveAsRequest,
  ExcelSaveRequest,
  ExcelSaveResult,
} from '../../shared/types'
import { IPC } from '../../shared/ipc-channels'
import { loggedHandle } from './logged-handle'

const MAX_WORKBOOK_BYTES = 150 * 1024 * 1024
const EXCEL_FILTERS = [{ name: 'Excel Workbook', extensions: ['xlsx'] }]

interface AuthorizedDocument {
  ownerWebContentsId: number
  path: string
}

function focused(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function workbookBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError('Workbook payload must be a Uint8Array')
  if (value.byteLength > MAX_WORKBOOK_BYTES) throw new RangeError('Workbook exceeds the 150 MB limit')
  return value
}

function ensureXlsxName(name: string): string {
  const safeName = basename(name.trim()) || 'Workbook.xlsx'
  return extname(safeName).toLocaleLowerCase() === '.xlsx' ? safeName : `${safeName}.xlsx`
}

async function atomicWrite(path: string, bytes: Uint8Array, mode?: number): Promise<void> {
  const temporaryPath = `${path}.bridgic-${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, bytes, { mode: mode ?? 0o600 })
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

/** Register capability-scoped .xlsx I/O. Paths never cross the preload bridge. */
export function registerExcelHandlers(): void {
  const documents = new Map<string, AuthorizedDocument>()
  const ownersWithCleanup = new WeakSet<WebContents>()

  const authorize = (event: IpcMainInvokeEvent, path: string): string => {
    const documentId = randomUUID()
    documents.set(documentId, { ownerWebContentsId: event.sender.id, path })
    if (!ownersWithCleanup.has(event.sender)) {
      ownersWithCleanup.add(event.sender)
      const ownerWebContentsId = event.sender.id
      event.sender.once('destroyed', () => {
        for (const [id, document] of documents) {
          if (document.ownerWebContentsId === ownerWebContentsId) documents.delete(id)
        }
      })
    }
    return documentId
  }

  const documentResult = async (
    documentId: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<ExcelDocumentHandle> => ({
    documentId,
    fileName: basename(path),
    bytes,
    mtimeMs: (await stat(path)).mtimeMs,
  })

  loggedHandle(IPC.excel.open, async (event): Promise<ExcelOpenResult> => {
    const options: OpenDialogOptions = {
      title: 'Open Excel Workbook',
      properties: ['openFile'],
      filters: EXCEL_FILTERS,
    }
    const win = focused()
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const path = result.filePaths[0]
    if (extname(path).toLocaleLowerCase() !== '.xlsx') {
      throw new Error('Only .xlsx workbooks can be opened')
    }
    const file = await stat(path)
    if (file.size > MAX_WORKBOOK_BYTES) throw new RangeError('Workbook exceeds the 150 MB limit')
    const bytes = new Uint8Array(await readFile(path))
    const documentId = authorize(event, path)
    return { canceled: false, document: await documentResult(documentId, path, bytes) }
  })

  loggedHandle(
    IPC.excel.save,
    async (event, request: ExcelSaveRequest): Promise<ExcelSaveResult> => {
      const document = documents.get(request.documentId)
      if (!document || document.ownerWebContentsId !== event.sender.id) {
        throw new Error('Workbook write capability is invalid or expired')
      }
      const current = await stat(document.path)
      if (Math.abs(current.mtimeMs - request.expectedMtimeMs) > 1) {
        return { ok: false, reason: 'conflict' }
      }
      await atomicWrite(document.path, workbookBytes(request.bytes), current.mode)
      const saved = await documentResult(request.documentId, document.path, new Uint8Array())
      return {
        ok: true,
        documentId: saved.documentId,
        fileName: saved.fileName,
        mtimeMs: saved.mtimeMs,
      }
    },
    { transformLogArgs: ([request]) => ({
      documentId: (request as ExcelSaveRequest | undefined)?.documentId,
      bytes: (request as ExcelSaveRequest | undefined)?.bytes?.byteLength,
    }) },
  )

  loggedHandle(
    IPC.excel.saveAs,
    async (event, request: ExcelSaveAsRequest): Promise<ExcelSaveResult> => {
      const suggestedName = ensureXlsxName(request.suggestedName)
      const options = {
        title: 'Save Excel Workbook',
        defaultPath: suggestedName,
        filters: EXCEL_FILTERS,
      }
      const win = focused()
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, reason: 'canceled' }
      const path = extname(result.filePath).toLocaleLowerCase() === '.xlsx'
        ? result.filePath
        : `${result.filePath}.xlsx`
      await atomicWrite(path, workbookBytes(request.bytes))
      const documentId = authorize(event, path)
      const saved = await documentResult(documentId, path, new Uint8Array())
      return {
        ok: true,
        documentId: saved.documentId,
        fileName: saved.fileName,
        mtimeMs: saved.mtimeMs,
      }
    },
    { transformLogArgs: ([request]) => ({
      suggestedName: (request as ExcelSaveAsRequest | undefined)?.suggestedName,
      bytes: (request as ExcelSaveAsRequest | undefined)?.bytes?.byteLength,
    }) },
  )
}
