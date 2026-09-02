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
const { messageFamily, streamingFamily, thinkingModeFamily } = await import('@/atoms/agent')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { i18n } = await import('@/lib/i18n')
const { PresentationModePane } = await import('../PresentationModePane')

describe('PresentationModePane', () => {
  it('shows the four-stage production skeleton and current stage', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-presentation-pane'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_compose',
      presentationGoal: 'Explain the product strategy to the board',
      presentationStepIndex: 1,
      presentationReports: [
        {
          stage: 'ppt_plan',
          stepId: 'map_slides',
          summary: 'Mapped four chapters into twelve slides.',
          evidence: Array.from("['.presentation/plan.md']"),
        },
        {
          stage: 'ppt_compose',
          stepId: 'build_slide_shells',
          summary: 'Created twelve slide shells from the selected visual system.',
          evidence: ['slides 1-12'],
        },
      ],
    })
    store.set(streamingFamily(sessionId), {
      messageId: 'presentation-stream',
      content: '',
      toolCalls: [],
      blocks: [],
      startedAt: Date.now(),
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <PresentationModePane />
        </Provider>,
      )
    })

    const stages = host.querySelectorAll('[data-stage]')
    expect(stages).toHaveLength(4)
    expect(host.querySelector('[data-stage="ppt_brief"]')?.getAttribute('data-state')).toBe('complete')
    expect(host.querySelector('[data-stage="ppt_plan"]')?.getAttribute('data-state')).toBe('complete')
    expect(host.querySelector('[data-stage="ppt_compose"]')?.getAttribute('data-state')).toBe('current')
    expect(host.querySelector('[data-stage="ppt_review"]')?.getAttribute('data-state')).toBe('pending')
    expect(host.querySelector('[data-step="build_slide_shells"]')?.getAttribute('data-state')).toBe('complete')
    expect(host.querySelector('[data-step="fill_slide_content"]')?.getAttribute('data-state')).toBe('current')
    expect(host.querySelector('[data-step="create_visuals"]')?.getAttribute('data-state')).toBe('pending')
    expect(host.textContent).toContain('product strategy')
    expect(host.querySelector('[data-testid="presentation-overview"]')).not.toBeNull()
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('46')
    expect(host.querySelectorAll('[data-testid="presentation-step-spinner"]')).toHaveLength(1)
    expect(host.querySelector('[data-testid="presentation-step-spinner"]')?.getAttribute('aria-label')).toBe(
      i18n.t('presentationMode.status.running'),
    )
    expect(host.querySelector('[class*="animate-presentation-breathe"]')).toBeNull()
    expect(host.querySelector('[data-testid="presentation-report-map_slides"]')?.textContent).toContain('twelve slides')
    expect(host.querySelector('[data-testid="presentation-report-map_slides"]')?.textContent).toContain('.presentation/plan.md')
    expect(host.querySelector('[data-testid="presentation-report-map_slides"]')?.querySelectorAll('span')).toHaveLength(1)
    expect(host.querySelector('[data-testid="presentation-report-build_slide_shells"]')?.textContent).toContain('slide shells')
    expect(host.querySelector('[data-stage="ppt_brief"] [data-step]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows Brief as the running stage without inventing a production substep', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-presentation-brief'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_brief',
      presentationGoal: 'Create a history presentation',
      presentationStepIndex: 0,
      presentationReports: [],
    })
    store.set(streamingFamily(sessionId), {
      messageId: 'presentation-brief-stream',
      content: '',
      toolCalls: [],
      blocks: [],
      startedAt: Date.now(),
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <PresentationModePane />
        </Provider>,
      )
    })

    expect(host.querySelector('[data-stage="ppt_brief"] [data-step]')).toBeNull()
    expect(host.querySelectorAll('[data-testid="presentation-stage-spinner"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-testid="presentation-step-spinner"]')).toHaveLength(0)
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0')

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows a failed status when the active presentation turn ends with an error', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-presentation-failed'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_brief',
      presentationGoal: 'Create a history presentation',
      presentationStepIndex: 0,
      presentationReports: [],
    })
    store.set(messageFamily(sessionId), [{
      id: 'failed-turn',
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [],
      done: true,
      error: 'The presentation could not start.',
      createdAt: Date.now(),
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <PresentationModePane />
        </Provider>,
      )
    })

    expect(host.querySelector('[data-testid="presentation-status"]')?.textContent).toBe(
      i18n.t('presentationMode.status.failed'),
    )
    expect(host.querySelector('[data-testid="presentation-status"]')?.textContent).not.toBe(
      i18n.t('presentationMode.status.paused'),
    )

    await act(async () => root.unmount())
    host.remove()
  })
})
