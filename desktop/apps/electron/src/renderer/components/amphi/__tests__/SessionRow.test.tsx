import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SessionRow } = await import('../SessionRow')

describe('SessionRow', () => {
  it('prioritizes a pending interaction over a stale running projection', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const callbacks = {
      onSelect: () => undefined,
      onOpenMenu: () => undefined,
      onCloseMenu: () => undefined,
      onStartRename: () => undefined,
      onCommitRename: () => undefined,
      onCancelRename: () => undefined,
      onDelete: () => undefined,
    }

    await act(async () => {
      root.render(
        <SessionRow
          session={{
            id: 'running',
            title: '论文筛选',
            stage: '生成',
            isRunning: true,
            hasRedDot: true,
            hasPendingInteraction: true,
            pendingInteractionLabel: '等待工具审批',
          }}
          active={false}
          menuOpen={false}
          editing={false}
          {...callbacks}
        />,
      )
    })

    const running = host.querySelector('[aria-label="Agent 正在运行"]')
    const complete = host.querySelector('[aria-label="有新完成内容"]')
    const interaction = host.querySelector('[aria-label="等待工具审批"]')
    expect(running).toBeNull()
    expect(complete?.querySelector('svg')).not.toBeNull()
    expect(complete?.className).toContain('text-status-success')
    expect(interaction?.querySelector('svg')).not.toBeNull()
    expect(interaction?.className).toContain('text-status-info')
    expect(host.textContent).toContain('生成')
    expect(host.textContent).not.toContain('正在运行')

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows a Child lifecycle hint only while a non-prominent subtree is collapsed', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let selected = 0
    let toggled = 0
    const callbacks = {
      onSelect: () => {
        selected += 1
      },
      onToggleChildren: () => {
        toggled += 1
      },
      onOpenMenu: () => undefined,
      onCloseMenu: () => undefined,
      onStartRename: () => undefined,
      onCommitRename: () => undefined,
      onCancelRename: () => undefined,
      onDelete: () => undefined,
    }
    const renderRow = (expanded: boolean) => (
      <SessionRow
        session={{
          id: 'parent',
          title: '父会话',
          backgroundChildStatusIndicator: {
            indicator: 'spinner',
            label: '子 Agent 正在运行',
          },
        }}
        active={false}
        childCount={1}
        expanded={expanded}
        menuOpen={false}
        editing={false}
        {...callbacks}
      />
    )

    await act(async () => root.render(renderRow(false)))

    const childRunning = host.querySelector('[aria-label="子 Agent 正在运行"]')
    expect(childRunning?.querySelectorAll('.agent-activity-wave > span')).toHaveLength(3)
    expect(childRunning?.closest('button')?.getAttribute('aria-label')).toBe('展开子会话')
    expect(host.querySelector('[aria-label="展开子会话"]')).not.toBeNull()
    await act(async () => (childRunning as HTMLElement).click())
    expect(toggled).toBe(1)
    expect(selected).toBe(0)

    await act(async () => root.render(renderRow(true)))

    expect(host.querySelector('[aria-label="子 Agent 正在运行"]')).toBeNull()
    expect(host.querySelector('[aria-label="收起子会话"]')).not.toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('projects a foreground Child interaction onto its parent Session', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <SessionRow
          session={{
            id: 'parent-wait',
            title: '父会话',
            isRunning: true,
            foregroundChildStatusIndicator: {
              indicator: 'attention',
              label: '子 Agent：等待你的回答',
            },
          }}
          active={false}
          menuOpen={false}
          editing={false}
          onSelect={() => undefined}
          onOpenMenu={() => undefined}
          onCloseMenu={() => undefined}
          onStartRename={() => undefined}
          onCommitRename={() => undefined}
          onCancelRename={() => undefined}
          onDelete={() => undefined}
        />,
      )
    })

    expect(host.querySelector('[aria-label="子 Agent：等待你的回答"] svg')).not.toBeNull()
    expect(host.querySelector('[aria-label="Agent 正在运行"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows a background Child interaction beside the count while collapsed', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <SessionRow
          session={{
            id: 'parent-background-wait',
            title: '父会话',
            backgroundChildStatusIndicator: {
              indicator: 'attention',
              label: '子 Agent：等待你的回答',
            },
          }}
          active={false}
          childCount={1}
          expanded={false}
          menuOpen={false}
          editing={false}
          onSelect={() => undefined}
          onToggleChildren={() => undefined}
          onOpenMenu={() => undefined}
          onCloseMenu={() => undefined}
          onStartRename={() => undefined}
          onCommitRename={() => undefined}
          onCancelRename={() => undefined}
          onDelete={() => undefined}
        />,
      )
    })

    const interaction = host.querySelector('[aria-label="子 Agent：等待你的回答"]')
    expect(interaction?.closest('button')?.getAttribute('aria-label')).toBe('展开子会话')

    await act(async () => root.unmount())
    host.remove()
  })
})
