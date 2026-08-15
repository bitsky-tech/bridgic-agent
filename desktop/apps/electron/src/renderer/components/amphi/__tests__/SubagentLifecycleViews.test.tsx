import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Provider, createStore } = await import('jotai')
const { SubagentCard } = await import('../SubagentCard')
const { SubagentGroup } = await import('../SubagentGroup')

describe('Child lifecycle views', () => {
  it('renders awaiting_subagents as progress without an action badge', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <SubagentCard block={{
            type: 'subagent',
            invocationId: 'child-join',
            goal: '汇总并行结果',
            status: 'awaiting_subagents',
          }} />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('等待子 Agent')
    expect(host.querySelector('.bg-status-error')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('uses the ordinary interaction bubble instead of a red action dot', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <SubagentCard block={{
            type: 'subagent',
            invocationId: 'child-human',
            goal: '询问用户',
            status: 'awaiting_human',
          }} />
        </Provider>,
      )
    })

    const interaction = host.querySelector('[aria-label="等待你的回答"]')
    expect(interaction?.querySelector('svg')).not.toBeNull()
    expect(host.querySelector('.bg-status-error')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps child joins, human questions, and tool approvals separate in a group', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <SubagentGroup subagents={[
            {
              invocationId: 'child-join',
              goal: '等待子任务',
              status: 'awaiting_subagents',
            },
            {
              invocationId: 'child-human',
              goal: '等待回答',
              status: 'awaiting_human',
            },
            {
              invocationId: 'child-permission',
              goal: '等待审批',
              status: 'awaiting_permission',
            },
          ]} />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('等待子任务 1')
    expect(host.textContent).toContain('等待回答 1')
    expect(host.textContent).toContain('等待审批 1')
    expect(host.textContent).not.toContain('等待确认')

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps sequential CLI children expanded until the user collapses them', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const renderGroup = async (subagents: Parameters<typeof SubagentGroup>[0]['subagents']) => {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <SubagentGroup subagents={subagents} />
          </Provider>,
        )
      })
    }

    await renderGroup([{ invocationId: 'child-1', goal: '检查第一个文件', status: 'running' }])
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded]')
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')

    await renderGroup([{ invocationId: 'child-1', goal: '检查第一个文件', status: 'completed' }])
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')

    await renderGroup([
      { invocationId: 'child-1', goal: '检查第一个文件', status: 'completed' },
      { invocationId: 'child-2', goal: '检查第二个文件', status: 'running' },
    ])
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => toggle?.click())
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')

    await renderGroup([
      { invocationId: 'child-1', goal: '检查第一个文件', status: 'completed' },
      { invocationId: 'child-2', goal: '检查第二个文件', status: 'completed' },
      { invocationId: 'child-3', goal: '检查第三个文件', status: 'running' },
    ])
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => root.unmount())
    host.remove()
  })
})
