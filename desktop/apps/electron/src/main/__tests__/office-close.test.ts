import { describe, expect, it, mock } from 'bun:test'
import type { IpcMainInvokeEvent } from 'electron'
import type { EmbeddedPowerPointManager } from '../embedded-powerpoint-manager'
import { electronModuleMock, loggerModuleMock, testIpcHandlers } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { registerOfficeCloseHandler } = await import('../handlers/office-close')
const { registerPowerPointHandlers } = await import('../handlers/powerpoint')
const { IPC } = await import('../../shared/ipc-channels')

function harness(prepareClose?: (sender: number) => Promise<unknown>, requireSessionId = false) {
  const owners = new Map([[17, 'session-a'], [18, 'session-b']])
  const events: unknown[][] = []
  const closed: number[] = []
  testIpcHandlers.clear()
  registerOfficeCloseHandler({
    requestChannel: 'test-close',
    closedEvent: 'test-closed',
    host: {
      sessionForContents: (sender) => {
        const owner = owners.get(sender)
        if (!owner) throw new Error('Sender is no longer owned')
        return owner
      },
      closeCurrentSession: (sender) => { closed.push(sender) },
    },
    emitToHost: (...args) => { events.push(args) },
    prepareClose,
    requireSessionId,
  })
  const request = (sender: number, sessionId?: string) => testIpcHandlers.get('test-close')!(
    { sender: { id: sender } } as IpcMainInvokeEvent, sessionId,
  )
  return { owners, events, closed, request }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('Office close handshake', () => {
  it('rejects an unrelated renderer before running any checkpoint', async () => {
    const prepare = mock(async () => {})
    const host = harness(prepare)
    await expect(host.request(99)).rejects.toThrow('no longer owned')
    await nextTurn()
    expect(prepare).not.toHaveBeenCalled()
    expect(host.events).toEqual([])
    expect(host.closed).toEqual([])
  })

  it('waits for preparation, publishes the owner, then destroys only the original sender', async () => {
    let finish!: () => void
    const host = harness(() => new Promise<void>((resolve) => { finish = resolve }))
    const request = host.request(17)
    expect(host.events).toEqual([])
    finish()
    await request
    expect(host.events).toEqual([['test-closed', 'session-a']])
    expect(host.closed).toEqual([])
    host.owners.delete(17)
    host.owners.set(19, 'session-a')
    await nextTurn()
    expect(host.closed).toEqual([17])
  })

  it('does not notify or destroy after a target is replaced during its checkpoint', async () => {
    let finish!: () => void
    const host = harness(() => new Promise<void>((resolve) => { finish = resolve }))
    const request = host.request(17)
    host.owners.delete(17)
    host.owners.set(19, 'session-a')
    finish()
    await expect(request).rejects.toThrow('no longer owned')
    await nextTurn()
    expect(host.events).toEqual([])
    expect(host.closed).toEqual([])
  })

  it('leaves checkpoint failure policy to the adapter', async () => {
    const host = harness(async () => { throw new Error('checkpoint failed') })
    await expect(host.request(17)).rejects.toThrow('checkpoint failed')
    await nextTurn()
    expect(host.events).toEqual([])
    expect(host.closed).toEqual([])
  })

  it('preserves protocols requiring the sender to name its own Session', async () => {
    const host = harness(undefined, true)
    await expect(host.request(17, 'session-b')).rejects.toThrow('does not own')
    await expect(host.request(17)).rejects.toThrow('does not own')
    expect(host.events).toEqual([])
    await host.request(17, 'session-a')
    expect(host.events).toEqual([['test-closed', 'session-a']])
    await nextTurn()
    expect(host.closed).toEqual([17])
  })

  it('wires PowerPoint through the same handshake while retaining its Session argument', async () => {
    const closed: number[] = []
    const events: unknown[][] = []
    testIpcHandlers.clear()
    registerPowerPointHandlers({
      sessionForContents: (sender: number) => {
        if (sender !== 17) throw new Error('PowerPoint Session does not own this renderer')
        return 'session-a'
      },
      closeCurrentSession: (sender: number) => { closed.push(sender) },
    } as unknown as EmbeddedPowerPointManager, (...args) => { events.push(args) })
    const request = testIpcHandlers.get(IPC.powerpoint.requestClose)!
    const event = { sender: { id: 17 } } as IpcMainInvokeEvent
    await expect(request(event, 'session-b')).rejects.toThrow('does not own')
    await expect(request(event)).rejects.toThrow('does not own')
    expect(events).toEqual([])
    await request(event, 'session-a')
    expect(events).toEqual([[IPC.events.powerPointCloseRequested, 'session-a']])
    expect(closed).toEqual([])
    await nextTurn()
    expect(closed).toEqual([17])
  })
})
