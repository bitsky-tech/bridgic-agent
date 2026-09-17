import { describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { ExcelHost } from '../excel-host'
import type { ExcelOpenResult } from '../../shared/types'
import { electronModuleMock, loggerModuleMock, testIpcHandlers } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)
const { registerExcelHandlers } = await import('../handlers/excel')
const { IPC } = await import('../../shared/ipc-channels')

describe('Excel file identity', () => {
  it('reuses a canonical file handle within its owner, distinguishes same-name files and expires handles with the owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridgic-excel-identity-'))
    const sender = Object.assign(new EventEmitter(), { id: 810 })
    const otherSender = Object.assign(new EventEmitter(), { id: 811 })
    registerExcelHandlers({ consumeWorkbookOpenRequest: (_owner: number, path: string) => path } as ExcelHost)
    const open = (owner: typeof sender, path: string) => testIpcHandlers.get(IPC.excel.openRequestedWorkbook)!(
      { sender: owner } as unknown as IpcMainInvokeEvent, path,
    ) as Promise<ExcelOpenResult>
    try {
      const path = join(directory, 'report.xlsx')
      await mkdir(join(directory, 'other'))
      await writeFile(path, new Uint8Array([1, 2, 3]))
      await writeFile(join(directory, 'other', 'report.xlsx'), new Uint8Array([4]))
      const [first, repeated, sameName, otherSession] = await Promise.all([
        open(sender, path), open(sender, join(await realpath(directory), 'report.xlsx')),
        open(sender, join(directory, 'other', 'report.xlsx')), open(otherSender, path),
      ])
      if (first.canceled || repeated.canceled || sameName.canceled || otherSession.canceled) throw new Error('Expected file handles')
      expect(repeated.document.documentId).toBe(first.document.documentId)
      expect(sameName.document.documentId).not.toBe(first.document.documentId)
      expect(otherSession.document.documentId).not.toBe(first.document.documentId)
      sender.emit('destroyed')
      await expect(testIpcHandlers.get(IPC.excel.save)!({ sender } as unknown as IpcMainInvokeEvent, {
        documentId: first.document.documentId, expectedMtimeMs: first.document.mtimeMs, bytes: new Uint8Array(),
      })).rejects.toThrow('invalid or expired')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
