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
  // 断言"同一个 DOM 节点跨收起/展开存活"而非模拟键入:卸载重挂必然产生新节点,
  // 节点身份不变 ⇔ 卡片实例(及其本地 useState,含用户改到一半的名字)被保留。
  // 不走 React 受控输入的合成 onChange —— 它在多 happy-dom 测试文件同进程时不稳定。
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

    // 收起(header 里的按钮,不依赖 i18n 文案)。
    const collapseBtn = host.querySelector<HTMLElement>('header button')
    expect(collapseBtn).not.toBeNull()
    await act(async () => {
      collapseBtn!.click()
    })

    // 收起态:卡片仍挂载(旧实现在这里已把它卸载),只是 section 被 CSS 隐藏。
    const inputWhileCollapsed = host.querySelector<HTMLInputElement>('input')
    expect(inputWhileCollapsed).not.toBeNull()
    expect(inputWhileCollapsed!.closest('section')?.className).toContain('hidden')

    // 展开(collapsed 胶囊,带 aria-label)。
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
