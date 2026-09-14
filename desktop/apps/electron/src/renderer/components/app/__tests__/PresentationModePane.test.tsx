import { afterAll, beforeEach, describe, expect, it, jest } from 'bun:test'
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
const { presentationPaneViewFamily, presentationTemplateSelectionFamily } = await import('@/atoms/presentation-plan')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { i18n } = await import('@/lib/i18n')
const { PresentationModePane } = await import('../PresentationModePane')

beforeEach(async () => {
  await i18n.changeLanguage('zh')
})

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
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42')
    expect(host.querySelectorAll('[data-testid="presentation-step-spinner"]')).toHaveLength(1)
    expect(host.querySelector('[data-testid="presentation-step-spinner"]')?.getAttribute('aria-label')).toBe(
      i18n.t('presentationMode.status.running'),
    )
    expect(host.querySelector('[data-testid="presentation-step-spinner"] svg')?.classList.contains('animate-spin')).toBe(true)
    expect(host.querySelector('[class*="animate-presentation-breathe"]')).toBeNull()
    expect(host.querySelector('[data-testid="presentation-report-map_slides"]')?.textContent).toContain('twelve slides')
    expect(host.querySelector('[data-testid="presentation-report-map_slides"]')?.textContent).not.toContain('.presentation/plan.md')
    expect(host.querySelector('[data-testid="presentation-report-map_slides"]')?.querySelectorAll('span')).toHaveLength(0)
    expect(host.querySelector('[data-testid="presentation-report-build_slide_shells"]')?.textContent).toContain('slide shells')
    expect(host.querySelector('[data-stage="ppt_brief"] [data-step]')).toBeNull()
    expect(host.querySelector('[data-testid="presentation-status"]')?.parentElement?.textContent).not.toContain('/13')

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
    expect(host.querySelector('[data-testid="presentation-stage-spinner"] svg')?.classList.contains('animate-spin')).toBe(true)
    expect(host.querySelectorAll('[data-testid="presentation-step-spinner"]')).toHaveLength(0)
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0')

    await act(async () => root.unmount())
    host.remove()
  })

  it('opens compact source and editable slide-outline results in detail views', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-presentation-plan'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_plan',
      presentationGoal: 'Explain Su Shi\'s life',
      presentationStepIndex: 2,
      presentationReports: [
        { stage: 'ppt_plan', stepId: 'collect_evidence', summary: 'Collected sources.', evidence: [] },
        { stage: 'ppt_plan', stepId: 'map_slides', summary: 'Mapped the slides.', evidence: [] },
      ],
      presentationSources: [
        {
          id: 'source-001',
          kind: 'web',
          title: '苏轼年谱',
          locator: 'https://example.com/sushi',
          excerpt: '记录苏轼的重要生平节点。',
          usage: '用于生平时间线',
        },
        {
          id: 'source-002',
          kind: 'conversation',
          title: '用户的讲解要求',
          excerpt: '面向中学生进行通俗讲解。',
        },
      ],
      presentationOutline: [{
        id: 'chapter-001',
        title: '少年与入仕',
        summary: '从眉山成长讲到科举成名。',
        slides: [{
          id: 'slide-001',
          title: '从眉山走出的少年',
          purpose: '以人物起点建立亲近感',
          keyMessage: '家庭教育塑造了苏轼的底色。',
          contentOutline: ['眉山成长与家庭教育', '科举经历与初入仕途'],
          sourceIds: ['source-001'],
        }],
      }],
      presentationOutlineConfirmed: false,
      presentationOutlineConfirmationId: 'presentation-outline-1',
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <PresentationModePane />
        </Provider>,
      )
    })

    expect(host.querySelectorAll('[data-source-kind]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-testid="presentation-outline-chapter"]')).toHaveLength(0)
    expect(host.querySelector('[data-testid="presentation-open-sources"]')?.textContent).toContain('2 项')
    expect(host.querySelector('[data-testid="presentation-open-outline"]')?.textContent).toContain('1 章 · 1 页')

    await act(async () => {
      ;(host.querySelector('[data-testid="presentation-open-sources"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[data-testid="presentation-sources-detail"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-source-kind]')).toHaveLength(2)
    expect(host.querySelector('[data-testid="presentation-sources"]')?.textContent).toContain('苏轼年谱')

    await act(async () => {
      ;(host.querySelector('[data-testid="presentation-detail-back"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(host.querySelector('[data-testid="presentation-open-outline"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[data-testid="presentation-outline-detail"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-testid="presentation-outline-chapter"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-testid="presentation-outline-slide"]')).toHaveLength(0)
    expect(host.querySelector('[data-testid="presentation-outline"]')?.textContent).toContain('逐页大纲')

    await act(async () => {
      ;(host.querySelector('[aria-label="展开章节：少年与入仕"]') as HTMLButtonElement).click()
    })
    expect(host.querySelectorAll('[data-testid="presentation-outline-slide"]')).toHaveLength(1)
    expect((host.querySelector('[aria-label="章节标题"]') as HTMLInputElement | null)?.value).toBe('少年与入仕')
    expect((host.querySelector('[aria-label="内页标题"]') as HTMLInputElement | null)?.value).toBe('从眉山走出的少年')
    expect((host.querySelector('[aria-label="这一页承担的作用"]') as HTMLInputElement | null)?.value).toBe('以人物起点建立亲近感')
    expect((host.querySelector('[aria-label="本页内容提要，每行一项"]') as HTMLTextAreaElement | null)?.value).toBe(
      '眉山成长与家庭教育\n科举经历与初入仕途',
    )
    expect(host.querySelector('[data-testid="presentation-outline-confirm"]')).not.toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('opens the retrieved template gallery and shares the selected candidate', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-presentation-templates'
    const requestId = 'template-selection-1'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_plan',
      presentationStepIndex: 2,
      presentationReports: [],
      presentationOutlineConfirmed: true,
      presentationTemplateSelectionId: requestId,
      presentationTemplateSelectionStatus: 'pending',
      presentationTemplateCandidates: [
        {
          templateId: 'template-editorial-1',
          version: 'sha256:first',
          title: 'Editorial Research',
          aspectRatio: '16:9',
          slideCount: 18,
          semanticTags: ['editorial'],
          strengths: ['timeline'],
          colors: ['#F7F4EE', '#25324A', '#7566E8'],
          fonts: ['Aptos'],
          previewPaths: [
            'file:///tmp/editorial-cover.png',
            'file:///tmp/editorial-timeline.png',
            'file:///tmp/editorial-content.png',
          ],
          roleCoverage: 0.8,
          agenticFit: 'strong',
          agenticReason: 'Fits the research narrative.',
          agenticUseForRoles: ['cover', 'timeline'],
          agenticRisks: [],
        },
        {
          templateId: 'template-minimal-2',
          version: 'sha256:second',
          title: 'Minimal Lecture',
          semanticTags: ['minimal'],
          strengths: ['content'],
          colors: ['#FFFFFF', '#202020', '#4876EE'],
          fonts: [],
          previewPaths: [],
          agenticUseForRoles: ['content'],
          agenticRisks: [],
        },
      ],
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <PresentationModePane />
        </Provider>,
      )
    })

    expect(store.get(presentationPaneViewFamily(sessionId))).toBe('templates')
    expect(host.querySelector('[data-testid="presentation-templates-detail"]')).not.toBeNull()
    const cards = host.querySelectorAll<HTMLButtonElement>('[data-testid="presentation-template-card"]')
    expect(cards).toHaveLength(2)
    expect(host.textContent).toContain('Editorial Research')
    expect(host.textContent).toContain('版型覆盖 80%')
    expect(host.querySelector<HTMLImageElement>('img[alt="Editorial Research 模板预览"]')?.src).toBe('file:///tmp/editorial-cover.png')
    jest.useFakeTimers()
    try {
      await act(async () => {
        cards[0]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      })
      await act(async () => {
        jest.advanceTimersByTime(1_000)
      })
      expect(host.querySelector<HTMLImageElement>('img[alt="Editorial Research 模板预览"]')?.src).toBe('file:///tmp/editorial-timeline.png')
      expect(host.querySelector<HTMLElement>('[data-testid="presentation-template-preview"]')?.textContent).toContain('2/3')

      await act(async () => {
        cards[0]?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      })
      expect(host.querySelector<HTMLImageElement>('img[alt="Editorial Research 模板预览"]')?.src).toBe('file:///tmp/editorial-cover.png')
    } finally {
      jest.useRealTimers()
    }
    const confirm = host.querySelector<HTMLButtonElement>('[data-testid="presentation-template-confirm"]')
    expect(confirm?.disabled).toBe(true)

    await act(async () => cards[1]?.click())

    expect(store.get(presentationTemplateSelectionFamily(requestId))).toBe('template-minimal-2')
    expect(cards[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(confirm?.disabled).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps retry and skip available when template retrieval fails', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-presentation-template-failure'
    store.set(activeSessionIdAtom, sessionId)
    store.set(presentationPaneViewFamily(sessionId), 'templates')
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

    await act(async () => {
      root.render(
        <Provider store={store}>
          <PresentationModePane />
        </Provider>,
      )
    })

    expect(host.querySelector('[data-testid="presentation-template-error"]')?.textContent).toContain(
      'The local template index is unavailable.',
    )
    expect(host.querySelector('[data-testid="presentation-template-refresh"]')?.textContent).toContain('重新检索')
    expect(host.querySelector<HTMLButtonElement>('[data-testid="presentation-template-confirm"]')?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[data-testid="presentation-template-skip"]')?.disabled).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows a completed template choice as a selected read-only gallery', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-presentation-template-complete'
    const selectedTemplate = {
      templateId: 'template-editorial-selected',
      version: 'sha256:selected',
      title: 'Selected Editorial Template',
      semanticTags: ['editorial'],
      strengths: ['timeline'],
      colors: ['#F7F4EE'],
      fonts: [],
      previewPaths: [],
      agenticUseForRoles: ['cover'],
      agenticRisks: [],
    }
    store.set(activeSessionIdAtom, sessionId)
    store.set(presentationPaneViewFamily(sessionId), 'templates')
    store.set(thinkingModeFamily(sessionId), {
      mode: 'presentation',
      stage: 'ppt_compose',
      presentationStepIndex: 0,
      presentationReports: [],
      presentationOutlineConfirmed: true,
      presentationTemplateSelectionId: null,
      presentationTemplateSelectionStatus: 'selected',
      presentationTemplateCandidates: [selectedTemplate],
      presentationSelectedTemplate: selectedTemplate,
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <PresentationModePane />
        </Provider>,
      )
    })

    const card = host.querySelector<HTMLButtonElement>('[data-testid="presentation-template-card"]')
    expect(card?.getAttribute('aria-pressed')).toBe('true')
    expect(card?.getAttribute('aria-disabled')).toBe('true')
    expect(host.querySelector('[data-testid="presentation-template-refresh"]')).toBeNull()
    expect(host.querySelector('[data-testid="presentation-template-skip"]')).toBeNull()
    expect(host.querySelector('[data-testid="presentation-template-confirm"]')).toBeNull()

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
