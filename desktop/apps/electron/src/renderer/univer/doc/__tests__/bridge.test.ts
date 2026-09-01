/**
 * Tests for the agent-facing document bridge. The facade is faked structurally:
 * the real `FUniver` is checked against the same interface at compile time in
 * `main.ts`, so these tests only need to cover the bridge's own behavior.
 */
import { describe, expect, test } from 'bun:test'
import { DocBridge, DocBridgeError, renderDataStream } from '../bridge'

function fakeFacade(dataStream = 'Hello\r\v') {
  const calls: string[] = []
  let stream = dataStream
  let selection: [number, number] = [0, 0]
  const document = {
    appendText: async (text: string) => {
      calls.push(`append ${text}`)
      // Univer keeps the trailing paragraph and section marks at the very end.
      stream = stream.slice(0, -2) + text + stream.slice(-2)
      return true
    },
    getName: () => 'Notes',
    getSnapshot: () => ({ body: { dataStream: stream } }),
    insertText: async (text: string) => {
      calls.push(`insert ${text} at ${selection[0]}-${selection[1]}`)
      stream = stream.slice(0, selection[0]) + text + stream.slice(selection[1])
      return true
    },
    redo: async () => {
      calls.push('redo')
      return true
    },
    setSelection: (start: number, end: number) => {
      selection = [start, end]
    },
    undo: async () => {
      calls.push('undo')
      return true
    },
  }
  return {
    calls,
    facade: { getActiveDocument: () => document },
    facadeWithoutDocument: { getActiveDocument: () => null },
  }
}

describe('renderDataStream', () => {
  test('renders breaks as newlines without moving any offset', () => {
    const stream = 'One\rTwo\v'
    const text = renderDataStream(stream)
    expect(text).toBe('One\nTwo\n')
    expect(text.length).toBe(stream.length)
  })

  test('keeps tabs and replaces markers this bridge does not expose', () => {
    const stream = 'a\tb\bc'
    const text = renderDataStream(stream)
    expect(text).toBe('a\tb c')
    expect(text.length).toBe(stream.length)
  })
})

describe('DocBridge — status and reads', () => {
  test('reports the document name and its length', () => {
    const { facade } = fakeFacade('Hello\r\v')
    const status = new DocBridge(facade).status()
    expect(status).toEqual({ characters: 7, name: 'Notes', ready: true, revision: 0 })
  })

  test('reports not ready before the document exists instead of throwing', () => {
    const { facadeWithoutDocument } = fakeFacade()
    expect(new DocBridge(facadeWithoutDocument).status().ready).toBe(false)
  })

  test('read returns text whose offsets match the write offsets', () => {
    const { facade } = fakeFacade('One\rTwo\v')
    expect(new DocBridge(facade).read()).toEqual({ characters: 8, text: 'One\nTwo\n' })
  })
})

describe('DocBridge — writes', () => {
  test('append lands before the trailing marks and bumps the revision', async () => {
    const { calls, facade } = fakeFacade('Hi\r\v')
    const bridge = new DocBridge(facade)
    const result = await bridge.append(' there')
    expect(calls).toEqual(['append  there'])
    expect(bridge.read().text).toBe('Hi there\n\n')
    expect(result.offset).toBe(4)
    expect(bridge.status().revision).toBe(1)
  })

  test('insert always sets the selection instead of using the person’s caret', async () => {
    const { calls, facade } = fakeFacade('Hello\r\v')
    const bridge = new DocBridge(facade)
    await bridge.insert(' there', 5)
    expect(calls).toEqual(['insert  there at 5-5'])
    expect(bridge.read().text).toBe('Hello there\n\n')
  })

  test('replace overwrites exactly the requested span', async () => {
    const { facade } = fakeFacade('Hello world\r\v')
    const bridge = new DocBridge(facade)
    await bridge.replace(6, 11, 'there')
    expect(bridge.read().text).toBe('Hello there\n\n')
  })

  test('refuses an offset outside the document', async () => {
    const { calls, facade } = fakeFacade('Hi\r\v')
    const bridge = new DocBridge(facade)
    await expect(bridge.insert('x', 99)).rejects.toThrow(DocBridgeError)
    await expect(bridge.insert('x', -1)).rejects.toThrow(/between 0 and 4/)
    await expect(bridge.insert('x', 1.5)).rejects.toThrow(DocBridgeError)
    await expect(bridge.replace(3, 99, 'x')).rejects.toThrow(/must not exceed 4/)
    await expect(bridge.replace(3, 1, 'x')).rejects.toThrow(/must not be before/)
    expect(calls).toEqual([])
  })

  test('refuses empty text rather than writing nothing', async () => {
    const { facade } = fakeFacade()
    const bridge = new DocBridge(facade)
    await expect(bridge.append('')).rejects.toThrow(DocBridgeError)
    await expect(bridge.insert('', 0)).rejects.toThrow(DocBridgeError)
  })
})

describe('DocBridge — workbook operations', () => {
  test('snapshot, undo and redo reach the document', async () => {
    const { calls, facade } = fakeFacade('Hi\r\v')
    const bridge = new DocBridge(facade)
    expect(bridge.snapshot()).toEqual({ body: { dataStream: 'Hi\r\v' } })
    await bridge.undo()
    await bridge.redo()
    expect(calls).toEqual(['undo', 'redo'])
  })

  test('operations before the document exists report a clear reason', () => {
    const { facadeWithoutDocument } = fakeFacade()
    const bridge = new DocBridge(facadeWithoutDocument)
    expect(() => bridge.read()).toThrow(/not ready/)
    expect(() => bridge.snapshot()).toThrow(/not ready/)
  })
})
