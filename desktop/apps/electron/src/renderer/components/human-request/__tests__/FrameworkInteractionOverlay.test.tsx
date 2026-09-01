import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { AgentRole } = await import('@shared/types')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { messageFamily } = await import('@/atoms/agent')
const { FrameworkInteractionOverlay } = await import('../FrameworkInteractionOverlay')

/** Seed a store whose active session tail parks a pending workflow_confirm. */
function makeStoreWithPendingWorkflowConfirm() {
  const store = createStore()
  const sessionId = 'sess-wf-confirm'
  store.set(activeSessionIdAtom, sessionId)
  store.set(messageFamily(sessionId), [
    {
      id: 'a-1',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [
        {
          type: 'workflow_confirm',
          requestId: 'wfc-1',
          defaultName: '默认工作流名',
          status: 'pending',
          operation: 'create',
        },
      ],
      done: true,
      createdAt: 1,
    },
  ])
  return store
}

describe('FrameworkInteractionOverlay 收起/展开', () => {
  // Assert that the same DOM node survives collapse and expansion rather than simulating typing.
  // A remount creates a new node, so stable identity proves the card instance and local useState,
  // including a partially edited name, are retained. Avoid synthetic controlled-input onChange,
  // which is unstable when multiple happy-dom test files share a process.
  it('收起再展开后卡片不被卸载重挂(本地编辑态因此保留)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = makeStoreWithPendingWorkflowConfirm()

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FrameworkInteractionOverlay />
        </Provider>,
      )
    })

    const inputBefore = host.querySelector<HTMLInputElement>('input')
    expect(inputBefore).not.toBeNull()
    expect(inputBefore!.value).toBe('默认工作流名')

    // Collapse using the header button without depending on i18n copy.
    const collapseBtn = host.querySelector<HTMLElement>('header button')
    expect(collapseBtn).not.toBeNull()
    await act(async () => {
      collapseBtn!.click()
    })

    // While collapsed, the card remains mounted and only its section is hidden by CSS.
    const inputWhileCollapsed = host.querySelector<HTMLInputElement>('input')
    expect(inputWhileCollapsed).not.toBeNull()
    expect(inputWhileCollapsed!.closest('section')?.className).toContain('hidden')

    // Expand through the collapsed pill identified by aria-label.
    const expandBtn = host.querySelector<HTMLElement>('button[aria-label]')
    expect(expandBtn).not.toBeNull()
    await act(async () => {
      expandBtn!.click()
    })

    const inputAfter = host.querySelector<HTMLInputElement>('input')
    expect(inputAfter).toBe(inputBefore!)
    expect(inputAfter!.closest('section')?.className).not.toContain('hidden')

    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
})
