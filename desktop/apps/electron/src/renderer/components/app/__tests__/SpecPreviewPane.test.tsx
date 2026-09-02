import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Simulate } = await import('react-dom/test-utils')
const { createStore, Provider } = await import('jotai')
const {
  briefFamily,
  currentSpecDraftAtom,
  originalBriefFamily,
  pendingCommentsAtom,
  setSpecEditDraftAtom,
} = await import('@/atoms/build')
const { streamingFamily, thinkingModeFamily } = await import('@/atoms/agent')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { i18n } = await import('@/lib/i18n')
const { SpecPreviewPane } = await import('../SpecPreviewPane')
const { SESSION_STATUS_BAR_HEIGHT_PX } = await import('../SessionStatusBar')

async function renderDiffReview(
  sessionId: string,
  before: string,
  after: string,
  operation: 'create' | 'edit' = 'create',
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const store = createStore()
  store.set(activeSessionIdAtom, sessionId)
  store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
  store.set(streamingFamily(sessionId), {
    messageId: `assistant-${sessionId}`,
    content: '',
    toolCalls: [],
    blocks: [{
      type: 'task_confirm',
      requestId: `task-${sessionId}`,
      taskMarkdown: after,
      previousTaskMarkdown: before,
      operation,
      status: 'pending',
    }],
    startedAt: Date.now(),
  })

  await act(async () => {
    root.render(
      <Provider store={store}>
        <SpecPreviewPane />
      </Provider>,
    )
  })
  return { host, root, store }
}

function buttonByText(host: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label,
  ) ?? null
}

function floatingCommentButton(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(
    `button[aria-label="${i18n.t('specPreview.commentSelectionAria')}"]`,
  )
}

function diffValueByText(host: HTMLElement, kind: 'same' | 'added' | 'removed', text: string): HTMLElement {
  const row = Array.from(host.querySelectorAll<HTMLElement>(`[data-kind="${kind}"]`)).find(
    (candidate) => candidate.querySelector('[data-diff-value]')?.textContent?.trim() === text,
  )
  const value = row?.querySelector('[data-diff-value]')
  if (!(value instanceof HTMLElement)) {
    throw new Error(`expected ${kind} diff value: ${text}`)
  }
  return value
}

async function selectText(start: HTMLElement, end: HTMLElement = start) {
  const startNode = start.firstChild
  const endNode = end.firstChild
  if (!startNode || !endNode) throw new Error('expected diff text nodes')
  const range = document.createRange()
  range.setStart(startNode, 0)
  range.setEnd(endNode, endNode.textContent?.length ?? 0)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  await act(async () => {
    end.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  })
}

async function unmountReview(root: ReturnType<typeof createRoot>, host: HTMLElement) {
  window.getSelection()?.removeAllRanges()
  await act(async () => root.unmount())
  host.remove()
}

describe('SpecPreviewPane task review diff', () => {
  it('shows the original on edit entry and switches to a visible diff for confirmation', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-edit'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'build',
      stage: 'clarify',
      workflowId: 'wf-existing',
    })
    store.set(originalBriefFamily(sessionId), '# 任务\n旧问候语')
    store.set(briefFamily(sessionId), '# 任务\n旧问候语')

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SpecPreviewPane />
        </Provider>,
      )
    })
    expect(host.textContent).toContain(i18n.t('specPreview.originalFileName'))
    expect(host.textContent).toContain('旧问候语')
    expect(host.textContent).toContain(i18n.t('specPreview.badge.original'))
    expect(host.querySelector<HTMLElement>('[data-testid="spec-preview-header"]')?.style.height)
      .toBe(`${SESSION_STATUS_BAR_HEIGHT_PX}px`)

    await act(async () => {
      store.set(streamingFamily(sessionId), {
        messageId: 'assistant-edit-review',
        content: '',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-edit-review',
          taskMarkdown: '# 任务\n新问候语',
          status: 'pending',
        }],
        startedAt: Date.now(),
      })
    })

    expect(host.textContent).toContain(i18n.t('specPreview.fileName'))
    expect(host.textContent).not.toContain(i18n.t('specPreview.originalFileName'))
    expect(host.textContent).toContain(i18n.t('specPreview.diff'))
    expect(host.textContent).toContain(i18n.t('specPreview.latest'))
    expect(host.textContent).toContain('旧问候语')
    expect(host.textContent).toContain('新问候语')
    expect(host.textContent).toContain(i18n.t('specPreview.instructions.diff'))

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows the full document for a new Workflow first review and diffs later revisions', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-create'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(streamingFamily(sessionId), {
      messageId: 'assistant-create-review',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-create-review',
        taskMarkdown: '# 任务\n首次确认稿',
        previousTaskMarkdown: '',
        operation: 'create',
        status: 'pending',
      }],
      startedAt: Date.now(),
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SpecPreviewPane />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('首次确认稿')
    expect(buttonByText(host, i18n.t('specPreview.diff'))).toBeNull()
    expect(buttonByText(host, i18n.t('specPreview.latest'))).toBeNull()
    expect(host.querySelectorAll('[data-kind]')).toHaveLength(0)

    await act(async () => {
      store.set(streamingFamily(sessionId), {
        messageId: 'assistant-create-revision',
        content: '',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-create-revision',
          taskMarkdown: '# 任务\n第二次确认稿',
          previousTaskMarkdown: '# 任务\n首次确认稿',
          operation: 'create',
          status: 'pending',
        }],
        startedAt: Date.now(),
      })
    })

    expect(buttonByText(host, i18n.t('specPreview.diff'))).not.toBeNull()
    expect(buttonByText(host, i18n.t('specPreview.latest'))).not.toBeNull()
    expect(host.textContent).toContain('首次确认稿')
    expect(host.textContent).toContain('第二次确认稿')
    expect(host.querySelectorAll('[data-kind="removed"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-kind="added"]')).toHaveLength(1)

    await act(async () => root.unmount())
    host.remove()
  })

  it('compares an edit revision with the previous review instead of the saved original', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-edit-revision'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), {
      mode: 'build',
      stage: 'clarify',
      workflowId: 'wf-existing',
    })
    store.set(originalBriefFamily(sessionId), '# 任务\n已保存原稿')
    store.set(streamingFamily(sessionId), {
      messageId: 'assistant-edit-revision',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-edit-revision',
        taskMarkdown: '# 任务\n第二次确认稿',
        previousTaskMarkdown: '# 任务\n第一次确认稿',
        originalTaskMarkdown: '# 任务\n已保存原稿',
        operation: 'edit',
        status: 'pending',
      }],
      startedAt: Date.now(),
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SpecPreviewPane />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('第一次确认稿')
    expect(host.textContent).toContain('第二次确认稿')
    expect(host.textContent).not.toContain('已保存原稿')
    expect(host.querySelectorAll('[data-kind="removed"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-kind="added"]')).toHaveLength(1)

    await act(async () => root.unmount())
    host.remove()
  })

  it('switches back to the diff when a new review arrives after viewing the latest document', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-next-review-diff'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(streamingFamily(sessionId), {
      messageId: 'assistant-review-1',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-review-1',
        taskMarkdown: '# 任务\n第一次确认稿',
        previousTaskMarkdown: '# 任务\n初始稿',
        operation: 'create',
        status: 'pending',
      }],
      startedAt: Date.now(),
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SpecPreviewPane />
        </Provider>,
      )
    })
    expect(host.querySelectorAll('[data-kind]')).not.toHaveLength(0)

    const latestButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === i18n.t('specPreview.latest'),
    )
    if (!latestButton) throw new Error('expected latest-document toggle')
    await act(async () => latestButton.click())
    expect(host.querySelectorAll('[data-kind]')).toHaveLength(0)
    expect(host.textContent).toContain('第一次确认稿')
    expect(host.textContent).not.toContain('初始稿')

    await act(async () => {
      store.set(streamingFamily(sessionId), {
        messageId: 'assistant-review-2',
        content: '',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-review-2',
          taskMarkdown: '# 任务\n第二次确认稿',
          previousTaskMarkdown: '# 任务\n第一次确认稿',
          operation: 'create',
          status: 'pending',
        }],
        startedAt: Date.now(),
      })
    })

    expect(host.querySelectorAll('[data-kind]')).not.toHaveLength(0)
    expect(host.textContent).toContain('第一次确认稿')
    expect(host.textContent).toContain('第二次确认稿')

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows the latest document when two consecutive reviews are identical', async () => {
    const { host, root } = await renderDiffReview(
      'session-unchanged-review',
      '# 任务\n相同确认稿',
      '# 任务\n相同确认稿',
    )

    expect(host.textContent).toContain('相同确认稿')
    expect(buttonByText(host, i18n.t('specPreview.diff'))).toBeNull()
    expect(buttonByText(host, i18n.t('specPreview.latest'))).toBeNull()
    expect(host.textContent).not.toContain(i18n.t('specPreview.noChanges'))
    expect(host.querySelectorAll('[data-kind]')).toHaveLength(0)

    await unmountReview(root, host)
  })

  it('treats CRLF and LF line endings as the same review content', async () => {
    const { host, root } = await renderDiffReview(
      'session-line-ending-only-review',
      '# 任务\r\n相同确认稿',
      '# 任务\n相同确认稿',
    )

    expect(buttonByText(host, i18n.t('specPreview.diff'))).toBeNull()
    expect(buttonByText(host, i18n.t('specPreview.latest'))).toBeNull()
    expect(host.querySelectorAll('[data-kind]')).toHaveLength(0)

    await unmountReview(root, host)
  })

  it('shows the latest document when an edit review matches the saved task', async () => {
    const { host, root } = await renderDiffReview(
      'session-unchanged-edit-review',
      '# 任务\n已保存内容',
      '# 任务\n已保存内容',
      'edit',
    )

    expect(buttonByText(host, i18n.t('specPreview.diff'))).toBeNull()
    expect(buttonByText(host, i18n.t('specPreview.latest'))).toBeNull()
    expect(host.querySelectorAll('[data-kind]')).toHaveLength(0)

    await unmountReview(root, host)
  })

  it('leaves the diff view when the next review has no actual changes', async () => {
    const sessionId = 'session-review-becomes-unchanged'
    const { host, root, store } = await renderDiffReview(
      sessionId,
      '# 任务\n初始稿',
      '# 任务\n第一次确认稿',
    )

    expect(buttonByText(host, i18n.t('specPreview.diff'))).not.toBeNull()
    expect(host.querySelectorAll('[data-kind]')).not.toHaveLength(0)
    await selectText(diffValueByText(host, 'added', '第一次确认稿'))
    expect(floatingCommentButton(host)).not.toBeNull()

    await act(async () => {
      store.set(streamingFamily(sessionId), {
        messageId: 'assistant-review-without-change',
        content: '',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-review-without-change',
          taskMarkdown: '# 任务\n第一次确认稿',
          previousTaskMarkdown: '# 任务\n第一次确认稿',
          operation: 'create',
          status: 'pending',
        }],
        startedAt: Date.now(),
      })
    })

    expect(host.textContent).toContain('第一次确认稿')
    expect(buttonByText(host, i18n.t('specPreview.diff'))).toBeNull()
    expect(buttonByText(host, i18n.t('specPreview.latest'))).toBeNull()
    expect(host.querySelectorAll('[data-kind]')).toHaveLength(0)
    expect(floatingCommentButton(host)).toBeNull()

    await unmountReview(root, host)
  })

  it('renders removed lines before added lines in every changed block', async () => {
    const { host, root } = await renderDiffReview(
      'session-change-order',
      '# 任务\n保留开头\n旧一\n旧二\n中间锚点\n旧三\n保留结尾',
      '# 任务\n保留开头\n新一\n新二\n中间锚点\n新三\n新四\n保留结尾',
    )
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-kind]')).map((row) => ({
      kind: row.dataset.kind,
      value: row.querySelector('[data-diff-value]')?.textContent?.trim(),
    }))

    expect(rows).toEqual([
      { kind: 'same', value: '# 任务' },
      { kind: 'same', value: '保留开头' },
      { kind: 'removed', value: '旧一' },
      { kind: 'removed', value: '旧二' },
      { kind: 'added', value: '新一' },
      { kind: 'added', value: '新二' },
      { kind: 'same', value: '中间锚点' },
      { kind: 'removed', value: '旧三' },
      { kind: 'added', value: '新三' },
      { kind: 'added', value: '新四' },
      { kind: 'same', value: '保留结尾' },
    ])

    await unmountReview(root, host)
  })

  for (const testCase of [
    { kind: 'same' as const, text: '保留正文' },
    { kind: 'added' as const, text: '新增正文' },
    { kind: 'removed' as const, text: '删除正文' },
  ]) {
    it(`allows selecting ${testCase.kind} diff body text to start a comment`, async () => {
      const { host, root } = await renderDiffReview(
        `session-select-${testCase.kind}`,
        '# 任务\n保留正文\n删除正文',
        '# 任务\n保留正文\n新增正文',
      )

      await selectText(diffValueByText(host, testCase.kind, testCase.text))

      expect(floatingCommentButton(host)).not.toBeNull()
      expect(host.querySelectorAll('[data-kind]')).not.toHaveLength(0)

      await unmountReview(root, host)
    })
  }

  it('adds a multiline diff comment with only body text and keeps the diff open', async () => {
    const { host, root, store } = await renderDiffReview(
      'session-multiline-comment',
      '# 任务\n保留正文\n删除正文',
      '# 任务\n保留正文\n新增正文',
    )
    const removedValue = diffValueByText(host, 'removed', '删除正文')
    const addedValue = diffValueByText(host, 'added', '新增正文')

    await selectText(removedValue, addedValue)
    const commentButton = floatingCommentButton(host)
    if (!commentButton) throw new Error('expected floating comment action')
    await act(async () => commentButton.click())

    expect(host.textContent).toContain(i18n.t('specPreview.commentSelection'))
    expect(host.textContent).toContain('删除正文\n新增正文')
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)
    expect(host.querySelectorAll('[data-kind]')).not.toHaveLength(0)

    const textarea = host.querySelector<HTMLTextAreaElement>(
      `textarea[placeholder="${i18n.t('specPreview.commentPlaceholder')}"]`,
    )
    if (!textarea) throw new Error('expected comment textarea')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setValue?.call(textarea, '请合并说明这两行的关系')
      Simulate.change(textarea)
    })
    const addButton = buttonByText(host, i18n.t('specPreview.add'))
    if (!addButton) throw new Error('expected add-comment action')
    await act(async () => addButton.click())

    expect(store.get(pendingCommentsAtom)).toHaveLength(1)
    expect(store.get(pendingCommentsAtom)[0]).toMatchObject({
      quote: '删除正文\n新增正文',
      text: '请合并说明这两行的关系',
    })
    expect(store.get(pendingCommentsAtom)[0]!.quote).not.toMatch(/[+−]/)
    expect(store.get(pendingCommentsAtom)[0]!.quote).not.toMatch(/\d/)
    expect(host.querySelectorAll('[data-kind]')).not.toHaveLength(0)
    expect(host.textContent).toContain(i18n.t('specPreview.instructions.diff'))
    expect(host.textContent).toContain(i18n.t('specPreview.pendingCount', { count: 1 }))

    await unmountReview(root, host)
  })

  it('clears an unconsumed floating selection when switching review tabs', async () => {
    const { host, root, store } = await renderDiffReview(
      'session-clear-selection',
      '# 任务\n旧正文',
      '# 任务\n新正文',
    )

    await selectText(diffValueByText(host, 'added', '新正文'))
    expect(floatingCommentButton(host)).not.toBeNull()

    const latestButton = buttonByText(host, i18n.t('specPreview.latest'))
    if (!latestButton) throw new Error('expected latest-document toggle')
    await act(async () => latestButton.click())
    expect(floatingCommentButton(host)).toBeNull()
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)

    const diffButton = buttonByText(host, i18n.t('specPreview.diff'))
    if (!diffButton) throw new Error('expected diff toggle')
    await act(async () => diffButton.click())
    expect(floatingCommentButton(host)).toBeNull()
    expect(host.querySelectorAll('[data-kind]')).not.toHaveLength(0)

    await unmountReview(root, host)
  })
})

/**
 * Unsubmitted input, including unadded comments and source edits, must survive per session.
 *
 * BuildProgressPanel renders this pane from `specPreviewOpenAtom`, stored **per session**, so
 * switching sessions unmounts it. Comment drafts once lived in component useState and vanished
 * on unmount. Unmounting and remounting with the same store reproduces the path exactly and also
 * verifies that drafts do not leak into another session.
 */
describe('SpecPreviewPane unsent drafts are per-session', () => {
  async function remount(store: ReturnType<typeof createStore>) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <Provider store={store}>
          <SpecPreviewPane />
        </Provider>,
      )
    })
    return { host, root }
  }

  async function typeInto(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setValue?.call(textarea, value)
      Simulate.change(textarea)
    })
  }

  function commentTextarea(host: HTMLElement): HTMLTextAreaElement | null {
    return host.querySelector<HTMLTextAreaElement>(
      `textarea[placeholder="${i18n.t('specPreview.commentPlaceholder')}"]`,
    )
  }

  /** Select diff text, open the floating Comment action, type partially, and do not add it. */
  async function startHalfTypedComment(sessionId: string, text: string) {
    const { host, root, store } = await renderDiffReview(sessionId, '# 任务\n旧正文', '# 任务\n新正文')
    await selectText(diffValueByText(host, 'added', '新正文'))
    const commentButton = floatingCommentButton(host)
    if (!commentButton) throw new Error('expected floating comment action')
    await act(async () => commentButton.click())
    const textarea = commentTextarea(host)
    if (!textarea) throw new Error('expected comment textarea')
    await typeInto(textarea, text)
    return { host, root, store }
  }

  it('restores a half-typed comment after leaving and re-entering the session', async () => {
    const half = '这个描述没必要存在,删掉它'
    const { host, root, store } = await startHalfTypedComment('session-draft-keep', half)
    expect(commentTextarea(host)?.value).toBe(half)

    // Switching away unmounts the pane; the draft is neither queued nor allowed to disappear.
    await unmountReview(root, host)
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)

    const back = await remount(store)
    expect(back.host.textContent).toContain(i18n.t('specPreview.commentSelection'))
    expect(back.host.textContent).toContain('新正文') // Restore the quote so the comment keeps its target.
    expect(commentTextarea(back.host)?.value).toBe(half)
    // The caret should follow existing text through focus + setSelectionRange on mount, but happy-dom
    // defaults selectionStart to value.length and cannot distinguish the fix. Bare focus() places it
    // at zero in Chromium, so this remains a manual check.
    await unmountReview(back.root, back.host)
  })

  it('does not carry a half-typed comment into another session', async () => {
    const { host, root, store } = await startHalfTypedComment('session-draft-a', '只属于 A 的评论')

    // If both sessions keep previews open, switching changes sessions without unmounting the pane.
    // Component-local draft state would remain visible and attach a quote from A to session B.
    await act(async () => {
      store.set(activeSessionIdAtom, 'session-draft-b')
      store.set(thinkingModeFamily('session-draft-b'), { mode: 'build', stage: 'clarify' })
      store.set(briefFamily('session-draft-b'), '# 任务\nB 的正文')
    })
    expect(commentTextarea(host)).toBeNull()
    expect(host.textContent).not.toContain('只属于 A 的评论')

    await act(async () => store.set(activeSessionIdAtom, 'session-draft-a'))
    expect(commentTextarea(host)?.value).toBe('只属于 A 的评论')

    await unmountReview(root, host)
  })

  it('drops the floating comment bubble when the session changes under it', async () => {
    const { host, root, store } = await renderDiffReview('session-bubble-a', '# 任务\n旧正文', '# 任务\n新正文')
    await selectText(diffValueByText(host, 'added', '新正文'))
    expect(floatingCommentButton(host)).not.toBeNull()

    // With previews open in both sessions, the pane stays mounted and local bubble state would persist.
    // Clicking it would queue A's quoted text under B's session ID, the same class of cross-session leak.
    await act(async () => {
      store.set(activeSessionIdAtom, 'session-bubble-b')
      store.set(thinkingModeFamily('session-bubble-b'), { mode: 'build', stage: 'clarify' })
      store.set(briefFamily('session-bubble-b'), '# 任务\nB 的正文')
    })
    expect(floatingCommentButton(host)).toBeNull()
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)

    await unmountReview(root, host)
  })

  it('restores the source-edit draft', async () => {
    const { host, root, store } = await renderDiffReview('session-edit-draft', '# 任务\n旧正文', '# 任务\n新正文')
    await act(async () => store.set(setSpecEditDraftAtom, '# 任务\n新正文'))

    const editor = host.querySelector<HTMLTextAreaElement>('textarea')
    if (!editor) throw new Error('expected source editor')
    await typeInto(editor, '# 任务\n手改到一半')
    expect(store.get(currentSpecDraftAtom).edit).toBe('# 任务\n手改到一半')

    await unmountReview(root, host)

    const back = await remount(store)
    expect(back.host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('# 任务\n手改到一半')
    await unmountReview(back.root, back.host)
  })
})
