import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { DirTreeNode } from '@shared/dir-tree'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { FileTreeView } = await import('../FileTreeView')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const nodes: DirTreeNode[] = [
  { kind: 'file', name: 'Deck.pptx', relPath: 'Deck.pptx', sizeBytes: 10 },
  { kind: 'file', name: 'Notes.txt', relPath: 'Notes.txt', sizeBytes: 10 },
]

describe('FileTreeView in-app file owners', () => {
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
