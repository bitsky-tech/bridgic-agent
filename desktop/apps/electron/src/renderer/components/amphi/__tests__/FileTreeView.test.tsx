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
          nodes={nodes}
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
    expect(onOpen).toHaveBeenLastCalledWith(nodes[0]!)

    await act(async () => text.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenLastCalledWith(nodes[1]!)

    await act(async () => root.unmount())
    host.remove()
  })
})
