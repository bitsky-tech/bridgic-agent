import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { IpcMainInvokeEvent } from 'electron'
import type { MountReferenceProvider } from '../handlers/mount-references'
import { electronModuleMock, loggerModuleMock, testIpcHandlers } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { IPC } = await import('../../shared/ipc-channels')
const { registerMountReferenceHandlers } = await import('../handlers/mount-references')

const compatibleProvider = (usage: { assetCount: number; elementCount: number; projectCount: number }): MountReferenceProvider => ({
  usage: async () => usage,
  validateReplacement: async () => ({ compatible: true }),
  remove: async () => usage,
  refresh: async () => undefined,
})

describe('mount reference IPC boundary', () => {
  beforeEach(() => testIpcHandlers.clear())

  it('aggregates reference usage without exposing editor-specific APIs to Files', async () => {
    registerMountReferenceHandlers([
      compatibleProvider({ assetCount: 2, elementCount: 3, projectCount: 1 }),
      compatibleProvider({ assetCount: 1, elementCount: 4, projectCount: 1 }),
    ])
    const usage = await testIpcHandlers.get(IPC.mountReferences.usage)?.({} as IpcMainInvokeEvent, 'session-a', 'mount-a')
    expect(usage).toEqual({ assetCount: 3, elementCount: 7, projectCount: 2 })
  })

  it('rejects relocation when any registered project type finds an incompatible reference', async () => {
    const rejecting: MountReferenceProvider = {
      ...compatibleProvider({ assetCount: 0, elementCount: 0, projectCount: 0 }),
      validateReplacement: async () => ({ compatible: false, reason: 'content-mismatch', assetName: 'chart.png' }),
    }
    registerMountReferenceHandlers([
      compatibleProvider({ assetCount: 0, elementCount: 0, projectCount: 0 }),
      rejecting,
    ])
    const result = await testIpcHandlers.get(IPC.mountReferences.rebind)?.({} as IpcMainInvokeEvent, 'session-a', 'mount-a', '/tmp/chart.png')
    expect(result).toEqual({
      ok: false,
      validation: { compatible: false, reason: 'content-mismatch', assetName: 'chart.png' },
    })
  })
})
