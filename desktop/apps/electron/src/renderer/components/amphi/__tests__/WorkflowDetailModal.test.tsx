import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { WorkflowDetail } from '@/lib/amphiClient'
import { DEFAULT_SETTINGS } from '@app/shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const testWindow = window as unknown as { api?: Record<string, unknown> }
testWindow.api = {
  ...testWindow.api,
  settings: {
    set: async () => {},
    get: async () => DEFAULT_SETTINGS,
  },
}
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { activeModalAtom, ComposerTarget, ModalKind } = await import('@/atoms/amphi')
const {
  DRAFT_SESSION_ID,
  activeSessionIdAtom,
  pendingComposerInsertsAtom,
  pendingComposerSeedAtom,
} = await import('@/atoms/sessions')
const { WorkflowDetailModal, WorkflowDetailView } = await import('../WorkflowDetailModal')

const detail: WorkflowDetail = {
  id: 'wf_test',
  name: '测试工作流',
  info: { created_at: '2026-07-17T10:00:00+08:00' },
  fields: {
    task: { value: '# 任务正文\n\n## 流程\n\n执行任务。' },
    explore: { value: '# 探索记录\n\n## 结论\n\n可行。' },
    verify: { value: '# 验证报告\n\n## Overall verdict\n\nPASS' },
    program: {
      files: [
        {
          path: 'WORKFLOW.md',
          content: '---\nname: test\ndescription: hidden metadata\n---\n\n# 使用说明\n\n## 准备\n\n准备输入。\n\n### 参数\n\n读取参数。\n\n## 完成\n\n返回结果。',
        },
        {
          path: 'VALIDATE.md',
          content: '# 验证说明\n\n## 检查结果\n\n确认输出完整。',
        },
        { path: 'scripts/run.py', language: 'python', content: 'print("ok")\n' },
        { path: 'scripts/__pycache__/run.cpython-313.pyc', content: 'compiled cache' },
      ],
    },
  },
}

describe('WorkflowDetailView', () => {
  it('renders saved artifacts as navigable documents with a derived outline', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(<WorkflowDetailView detail={detail} loadError="" />)
    })

    expect(host.textContent).toContain('执行源文件 · 3')
    expect(host.textContent).toContain('任务流程')
    expect(host.textContent).toContain('验证方法')
    expect(host.textContent).toContain('脚本文件')
    expect(host.textContent).toContain('构建文档 · 3')
    expect(host.textContent).toContain('任务定义')
    expect(host.textContent).toContain('探索报告')
    expect(host.textContent).not.toContain('scripts/run.py')
    expect(host.textContent).not.toContain('run.cpython-313.pyc')
    expect(host.textContent).toContain('本文大纲')
    expect(host.textContent).toContain('任务正文')
    expect(host.textContent).toContain('流程')
    expect(host.textContent).not.toContain('hidden metadata')
    const rendered = host.querySelector('aside')?.textContent ?? ''
    expect(rendered.indexOf('构建文档')).toBeLessThan(rendered.indexOf('执行源文件'))

    const taskButton = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('任务定义'))
    expect(taskButton).toBeDefined()
    expect(taskButton?.className).toContain('bg-accent-blue-subtle')

    const workflowButton = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('任务流程'))
    expect(workflowButton).toBeDefined()
    await act(async () => workflowButton?.click())
    expect(workflowButton?.className).toContain('bg-accent-blue-subtle')
    expect(host.textContent).toContain('准备')
    expect(host.textContent).toContain('参数')

    const scriptsButton = host.querySelector<HTMLButtonElement>('button[aria-label="展开脚本文件"]')
    expect(scriptsButton).toBeDefined()
    expect(scriptsButton?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => scriptsButton?.click())
    expect(host.textContent).toContain('scripts/run.py')
    expect(scriptsButton?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => taskButton?.click())

    expect(taskButton?.className).toContain('bg-accent-blue-subtle')
    expect(host.textContent).toContain('任务正文')
    expect(host.textContent).toContain('流程')

    await act(async () => root.unmount())
    host.remove()
  })

  it('falls back to the workflow source when task.md is unavailable', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const detailWithoutTask: WorkflowDetail = {
      ...detail,
      fields: {
        ...detail.fields,
        task: { value: '' },
      },
    }

    await act(async () => {
      root.render(<WorkflowDetailView detail={detailWithoutTask} loadError="" />)
    })

    const workflowButton = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('任务流程'))
    expect(workflowButton?.className).toContain('bg-accent-blue-subtle')
    expect(host.textContent).toContain('使用说明')
    expect(host.textContent).toContain('准备')

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps workflow information and runtime configuration separate from run results', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(<WorkflowDetailModal />)
    })

    expect(document.body.textContent).toContain('工作流信息')
    expect(document.body.textContent).toContain('运行配置')
    expect(document.body.textContent).not.toContain('运行结果')
    expect(document.body.textContent).not.toContain('运行记录')
    expect(document.body.textContent).not.toContain('待您处理')

    const configTab = document.querySelector<HTMLElement>('[data-testid="tab-运行配置"]')
    expect(configTab).toBeDefined()
    await act(async () => configTab?.click())
    expect(configTab?.className).toContain('border-brand-blue')

    await act(async () => root.unmount())
    host.remove()
  })

  it('starts a guided new conversation when opened from the Workflow center', async () => {
    const store = createStore()
    store.set(activeModalAtom, {
      type: ModalKind.WorkflowDetail,
      workflowId: 'wf_test',
      composerTarget: ComposerTarget.NewSession,
    })
    let closeCount = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowDetailModal
            workflowId="wf_test"
            name="测试工作流"
            composerTarget={ComposerTarget.NewSession}
            onClose={() => {
              closeCount += 1
            }}
          />
        </Provider>,
      )
    })

    const run = document.querySelector<HTMLButtonElement>(
      'button[aria-label="运行工作流 测试工作流"]',
    )
    expect(run).toBeDefined()
    await act(async () => run?.click())

    expect(closeCount).toBe(1)
    expect(store.get(activeModalAtom)).toBeNull()
    expect(store.get(activeSessionIdAtom)).toBe(DRAFT_SESSION_ID)
    expect(store.get(pendingComposerSeedAtom)?.segments[0]).toEqual({
      type: 'slash',
      id: 'wf_test',
      label: '测试工作流',
      resource: 'workflow',
    })

    await act(async () => root.unmount())
    host.remove()
  })

  it('inserts the Workflow into the current conversation for a Session detail', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-existing')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowDetailModal
            workflowId="wf_test"
            name="测试工作流"
            composerTarget={ComposerTarget.CurrentSession}
          />
        </Provider>,
      )
    })
    const run = document.querySelector<HTMLButtonElement>(
      'button[aria-label="运行工作流 测试工作流"]',
    )
    await act(async () => run?.click())

    expect(store.get(activeSessionIdAtom)).toBe('session-existing')
    expect(store.get(pendingComposerInsertsAtom)[0]?.[0]).toEqual({
      type: 'slash',
      id: 'wf_test',
      label: '测试工作流',
      resource: 'workflow',
    })

    await act(async () => root.unmount())
    host.remove()
  })
})
