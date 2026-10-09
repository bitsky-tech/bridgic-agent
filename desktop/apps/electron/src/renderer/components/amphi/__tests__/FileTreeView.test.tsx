import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { DirTreeNode } from '@shared/dir-tree'
import type { MountSummary } from '@/lib/amphiClient'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { FileTreeView } = await import('../FileTreeView')
const { MountRow } = await import('../MountRow')
const { Provider, createStore } = await import('jotai')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const nodes: DirTreeNode[] = [
  { kind: 'file', name: 'Deck.pptx', relPath: 'Deck.pptx', sizeBytes: 10 },
  { kind: 'file', name: 'Notes.txt', relPath: 'Notes.txt', sizeBytes: 10 },
]

describe('FileTreeView in-app file owners', () => {
  it('opens mounted Excel files once on a single click even with the old PPT-only policy', async () => {
    const onOpenRoot = mock(() => undefined)
    const mount: MountSummary = { id: 'excel-click', name: 'Book.XLSX', path: '/qa/Book.XLSX', kind: 'file', exists: true, size_bytes: 10, item_count: null, created_at: '' }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const noop = () => undefined
    try {
      await act(async () => root.render(<Provider store={createStore()}><MountRow
        mount={mount} sessionId="excel-click" menuOpen={false} onMenuToggle={noop}
        onCopyPath={noop} onOpenInFileManager={noop} onMentionRoot={noop} onMentionChild={noop}
        childMenuFor={null} onChildMenuToggle={noop} onCopyChildPath={noop} onRevealChild={noop}
        onOpenRoot={onOpenRoot} onOpenChild={noop} openOnSingleClick={(name) => name.endsWith('.pptx')}
      /></Provider>))
      const row = host.querySelector<HTMLElement>('.group')!
      await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
      expect(onOpenRoot).toHaveBeenCalledTimes(1)
      await act(async () => {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
      })
      expect(onOpenRoot).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('opens every supported Office format once on a single click without a custom policy', async () => {
    const onOpen = mock((_node: DirTreeNode) => undefined)
    const files: DirTreeNode[] = ['Book.XLSX', 'Report.docx', 'Slides.pptx', 'Legacy.xls'].map((name) => ({ name, relPath: name, kind: 'file', sizeBytes: 10 }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<FileTreeView nodes={files} expanded={new Set()} onToggle={() => undefined} onOpen={onOpen} />))
      for (const [index, file] of files.entries()) {
        const row = host.querySelector<HTMLElement>(`[data-file-tree-path="${file.relPath}"]`)!
        await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
        expect(onOpen).toHaveBeenCalledTimes(index < 3 ? index + 1 : index)
        await act(async () => {
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
        })
        expect(onOpen).toHaveBeenCalledTimes(index + 1)
        expect(onOpen).toHaveBeenLastCalledWith(file)
      }
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('opens claimed PPTX files once on click and leaves ordinary files on double-click', async () => {
    const onOpen = mock((_node: DirTreeNode) => undefined)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(
      <FileTreeView
        nodes={nodes}
        expanded={new Set()}
        onToggle={() => undefined}
        onOpen={onOpen}
        openOnSingleClick={(node) => node.name.toLowerCase().endsWith('.pptx')}
      />,
    ))
    const rows = host.querySelectorAll<HTMLElement>('[class*="group/tree-row"]')

    await act(async () => {
      rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
      rows[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenLastCalledWith(nodes[0])

    await act(async () => {
      rows[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      rows[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    })
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenLastCalledWith(nodes[1])

    await act(async () => root.unmount())
    host.remove()
  })
})

const wordNodes: DirTreeNode[] = [
  { name: 'report.docx', kind: 'file', relPath: 'report.docx', sizeBytes: 10 },
  { name: 'notes.txt', kind: 'file', relPath: 'notes.txt', sizeBytes: 5 },
]

describe('FileTreeView file opening', () => {
  it('opens DOCX on one click while retaining double-click for other files', async () => {
    const onOpen = mock((_node: DirTreeNode) => {})
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <FileTreeView
          expanded={new Set()}
          nodes={wordNodes}
          onOpen={onOpen}
          onToggle={() => undefined}
        />,
      )
    })
    const docx = host.querySelector<HTMLElement>('[data-file-tree-path="report.docx"]')!
    const text = host.querySelector<HTMLElement>('[data-file-tree-path="notes.txt"]')!

    await act(async () => docx.click())
    await act(async () => text.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenLastCalledWith(wordNodes[0]!)

    await act(async () => text.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenLastCalledWith(wordNodes[1]!)

    await act(async () => root.unmount())
    host.remove()
  })
})
