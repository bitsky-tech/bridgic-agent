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
const { messageFamily, thinkingModeFamily } = await import('@/atoms/agent')
const { presentationPaneViewFamily } = await import('@/atoms/presentation-plan')
const { FrameworkInteractionOverlay } = await import('../FrameworkInteractionOverlay')
const { PresentationTemplateSelectionCard } = await import('@/components/amphi/PresentationTemplateSelectionCard')

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

  it('uses the outline confirmation card as the entry to the outline editor', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'sess-outline-confirm'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_plan',
      presentationStepIndex: 3,
      presentationReports: [],
      presentationOutline: [{
        id: 'chapter-001',
        title: 'Opening',
        slides: [{
          id: 'slide-001',
          title: 'Why this matters',
          contentOutline: ['Frame the central question'],
          sourceIds: [],
        }],
      }],
      presentationOutlineConfirmationId: 'outline-1',
      presentationOutlineConfirmed: false,
    })
    store.set(messageFamily(sessionId), [{
      id: 'a-outline',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'presentation_outline_confirm',
        requestId: 'outline-1',
        status: 'pending',
      }],
      done: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FrameworkInteractionOverlay />
        </Provider>,
      )
    })

    const card = host.querySelector('[data-testid="presentation-outline-confirm-card"]')
    expect(card).not.toBeNull()
    expect(card?.querySelectorAll('button')).toHaveLength(2)
    const openButton = card?.querySelector<HTMLButtonElement>('button')
    await act(async () => openButton?.click())
    expect(store.get(presentationPaneViewFamily(sessionId))).toBe('outline')

    await act(async () => root.unmount())
    host.remove()
  })

  it('uses the compact template card as the entry to the right-pane gallery', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'sess-template-selection'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_plan',
      presentationStepIndex: 3,
      presentationReports: [],
      presentationOutlineConfirmed: true,
      presentationTemplateSelectionId: 'template-selection-1',
      presentationTemplateSelectionStatus: 'pending',
      presentationTemplateCandidates: [{
        templateId: 'template-editorial-1',
        version: 'sha256:test',
        title: 'Editorial Research',
        semanticTags: ['editorial'],
        strengths: ['timeline'],
        colors: ['#F7F4EE'],
        fonts: [],
        previewPaths: [],
        agenticUseForRoles: ['cover'],
        agenticRisks: [],
      }],
    })
    store.set(messageFamily(sessionId), [{
      id: 'a-template',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'presentation_template_selection',
        requestId: 'template-selection-1',
        status: 'pending',
      }],
      done: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FrameworkInteractionOverlay />
        </Provider>,
      )
    })

    const card = host.querySelector('[data-testid="presentation-template-selection-card"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('1 个匹配模板')
    const openButton = card?.querySelector<HTMLButtonElement>('button')
    await act(async () => openButton?.click())
    expect(store.get(presentationPaneViewFamily(sessionId))).toBe('templates')

    await act(async () => root.unmount())
    host.remove()
  })

  it('offers retry and skip when template retrieval has no candidates', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'sess-template-failure'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_plan',
      presentationStepIndex: 2,
      presentationReports: [],
      presentationOutlineConfirmed: true,
      presentationTemplateSelectionId: 'template-failure-1',
      presentationTemplateSelectionStatus: 'pending',
      presentationTemplateSelectionError: 'The local template index is unavailable.',
      presentationTemplateCandidates: [],
    })
    store.set(messageFamily(sessionId), [{
      id: 'a-template-failure',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'presentation_template_selection',
        requestId: 'template-failure-1',
        status: 'pending',
      }],
      done: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FrameworkInteractionOverlay />
        </Provider>,
      )
    })

    const card = host.querySelector('[data-testid="presentation-template-selection-card"]')
    expect(card?.textContent).toContain('本次未能得到可用的模板候选')
    expect(card?.textContent).toContain('The local template index is unavailable.')
    expect(card?.textContent).toContain('重新检索')
    expect(card?.textContent).toContain('不使用模板')

    await act(async () => root.unmount())
    host.remove()
  })

  it('does not attribute the current template to an older refreshed batch', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'sess-template-history'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_compose',
      presentationStepIndex: 0,
      presentationReports: [],
      presentationTemplateSelectionStatus: 'selected',
      presentationSelectedTemplate: {
        templateId: 'template-new-batch',
        version: 'sha256:new',
        title: 'Template from the new batch',
        semanticTags: [],
        strengths: [],
        colors: [],
        fonts: [],
        previewPaths: [],
        agenticUseForRoles: [],
        agenticRisks: [],
      },
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <PresentationTemplateSelectionCard
            sessionId={sessionId}
            block={{
              type: 'presentation_template_selection',
              requestId: 'template-old-batch',
              status: 'refresh_requested',
            }}
          />
        </Provider>,
      )
    })

    expect(host.textContent).not.toContain('Template from the new batch')

    await act(async () => root.unmount())
    host.remove()
  })
})
