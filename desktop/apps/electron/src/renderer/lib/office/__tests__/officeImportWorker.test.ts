import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { runOfficeImportWorker } from '../officeImportWorker'
import { importDocxInBackground } from '../../wordImport'
import { importPresentationInBackground } from '../../presentationImport'

const originalWorker = globalThis.Worker
let workers: TestWorker[] = []
class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = mock((_message: unknown, _transfer: Transferable[]) => {})
  terminate = mock(() => {})
  constructor() { workers.push(this) }
  reply(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
}
beforeEach(() => { workers = []; globalThis.Worker = TestWorker as unknown as typeof Worker })
afterEach(() => { globalThis.Worker = originalWorker })

describe('Office import workers', () => {
  it('transfers an owned Word input and releases its worker after conversion', async () => {
    const source = new Uint8Array([1, 2, 3])
    const pending = importDocxInBackground(source)
    const worker = workers[0]!
    const [bytes, transfer] = worker.postMessage.mock.calls[0]!
    expect(bytes).toEqual(source)
    expect(bytes).not.toBe(source)
    expect(transfer).toEqual([(bytes as Uint8Array).buffer])
    const value = { html: '<p>Imported</p>', warnings: [] }
    worker.reply({ ok: true, value })
    expect(await pending).toEqual(value)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('decodes PPT base64 in the worker and copies binary inputs without detaching callers', async () => {
    const encoded = importPresentationInBackground('AQID', 'deck.pptx')
    expect(workers[0]!.postMessage.mock.calls[0]).toEqual([{ input: 'AQID', fileName: 'deck.pptx', options: { restoreEditorModel: true } }, []])
    workers[0]!.reply({ ok: true, value: { slides: [] } })
    await encoded
    const input = new Uint8Array([1, 2, 3])
    const binary = importPresentationInBackground(input, 'deck.pptx', { slideNumbers: [2] })
    const [request, transfer] = workers[1]!.postMessage.mock.calls[0]! as [{ input: Uint8Array }, Transferable[]]
    expect(request.input).toEqual(input)
    expect(request.input.buffer).not.toBe(input.buffer)
    expect(transfer).toEqual([request.input.buffer])
    workers[1]!.reply({ ok: true, value: { slides: [] } })
    await binary
  })

  it('cancels imports and ignores late replies', async () => {
    const controller = new AbortController()
    const pending = importDocxInBackground(new Uint8Array(), controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
    expect(workers[0]!.onmessage).toBeNull()
    await expect(importDocxInBackground(new Uint8Array(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(workers).toHaveLength(1)
  })

  it('settles conversion, transport, startup, and deserialization failures', async () => {
    const first = importDocxInBackground(new Uint8Array())
    workers[0]!.reply({ ok: false, error: 'Invalid archive' })
    await expect(first).rejects.toThrow('Invalid archive')
    const second = importDocxInBackground(new Uint8Array())
    workers[1]!.onerror?.({ message: 'Worker failed' } as ErrorEvent)
    await expect(second).rejects.toThrow('Worker failed')
    const third = importDocxInBackground(new Uint8Array())
    workers[2]!.onmessageerror?.()
    await expect(third).rejects.toThrow('could not be transferred')
    await expect(runOfficeImportWorker(() => { throw new Error('Cannot start') }, {})).rejects.toThrow('Cannot start')
    await expect(runOfficeImportWorker(() => {
      const worker = new TestWorker()
      worker.postMessage.mockImplementation(() => { throw new Error('Cannot send') })
      return worker as unknown as Worker
    }, {})).rejects.toThrow('Cannot send')
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true)
  })
})
