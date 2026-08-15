import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { RunAgentLayerNav } = await import('../RunAgentLayerNav')

describe('RunAgentLayerNav', () => {
  it('uses the canonical exact Child lifecycle labels', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <RunAgentLayerNav
          mainSessionId="main"
          selectedSessionId="main"
          onSelect={() => undefined}
          subagents={[
            {
              sessionId: 'joining',
              title: '等待下级任务',
              status: 'awaiting_subagents',
              subagentMode: 'background',
            },
            {
              sessionId: 'permission',
              title: '等待工具调用',
              status: 'awaiting_permission',
              subagentMode: 'background',
            },
          ]}
        />,
      )
    })

    expect(host.querySelector('[aria-label="等待子 Agent"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="等待工具审批"]')).not.toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })
})
