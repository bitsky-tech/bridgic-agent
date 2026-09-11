import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { DesktopDebugTurn, DesktopDebugTurnsPage } from '@shared/debug-types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider, useAtomValue } = await import('jotai')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { DebugSessionProvider, useDebugSession } = await import('../DebugSessionProvider')
const { DebugToolsPanel, DebugRoundsPanel } = await import('../DebugPanel')

const originalFetch = globalThis.fetch
const mounted: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  await act(async () => { for (const root of mounted.splice(0)) root.unmount() })
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})
afterAll(async () => { await GlobalRegistrator.unregister() })

function turn(id: string, ordinal: number, sessionId = 'a', body = `Response ${id}`): DesktopDebugTurn {
  return { id, sessionId, sessionOrdinal: ordinal, status: 'completed', createdAt: '2026-09-11T00:00:00Z', userInput: '',
    finalAnswer: body, error: null, executionMode: null, maxRounds: null, model: 'recorded-model', durationMs: null,
    otaRecords: [{ think_scope: { mode: 'main', stage: 'answer' }, think_result: { step_content: body, tool_calls: [
      { call_id: `${id}-success`, tool: 'read_file', tool_arguments: [{ name: 'path', value: '/tmp/recorded.txt' }] },
      { call_id: `${id}-missing`, tool: 'read_file', tool_arguments: null },
      { call_id: `${id}-failed`, tool: 'write_file', tool_arguments: { content: '' } },
    ] }, action_result: { results: [
      { tool_id: `${id}-success`, tool_name: 'read_file', tool_arguments: { path: '/tmp/recorded.txt' }, tool_result: '', success: true },
      { tool_id: `${id}-failed`, tool_name: 'write_file', tool_arguments: { content: '' }, tool_result: null, success: false, error: 'Recorded failure' },
    ] } }], otaContext: null, otaContextSource: 'unavailable', agentState: null, contextUsage: null }
}

function page(sessionId: string, turns: DesktopDebugTurn[], nextCursor: string | null = null): DesktopDebugTurnsPage {
  return { sessionId, turns, nextCursor, hasMore: nextCursor !== null }
}

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input, 'http://debug.test')
  return new URL(input instanceof URL ? input.href : input.url, 'http://debug.test')
}

function deferredFetch() {
  const pending: { url: URL; signal: AbortSignal; resolve: (page: DesktopDebugTurnsPage) => void }[] = []
  globalThis.fetch = ((input: string | URL | Request, options?: RequestInit) => new Promise<Response>((resolve) => {
    pending.push({ url: requestUrl(input), signal: options!.signal as AbortSignal, resolve: value => resolve(Response.json(value)) })
  })) as typeof fetch
  return pending
}

function databaseFetch(read: () => DesktopDebugTurn[], size = 2) {
  const requests: URL[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = requestUrl(input)
    requests.push(url)
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]!)
    const all = read().filter(value => value.sessionId === sessionId).sort((a, b) => b.sessionOrdinal - a.sessionOrdinal || b.id.localeCompare(a.id))
    const cursor = url.searchParams.get('before')
    const start = cursor ? all.findIndex(value => value.id === cursor) + 1 : 0
    const items = all.slice(start, start + size)
    const more = start + size < all.length ? items.at(-1)!.id : null
    return Response.json(page(sessionId, items, more))
  }) as typeof fetch
  return requests
}

async function mount(panel?: 'tools' | 'rounds', sessionId = 'a') {
  const store = createStore()
  store.set(activeSessionIdAtom, sessionId)
  store.set(settingsAtom, { ...store.get(settingsAtom), locale: 'en' })
  let current!: ReturnType<typeof useDebugSession>
  function Probe({ active }: { active: boolean }) {
    current = useDebugSession()
    const id = useAtomValue(activeSessionIdAtom)
    if (!id) return null
    if (panel === 'tools') return <DebugToolsPanel sessionId={id} active={active} onClose={() => undefined} />
    if (panel === 'rounds') return <DebugRoundsPanel sessionId={id} active={active} onClose={() => undefined} />
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mounted.push(root)
  const render = async (active = true) => act(async () => {
    root.render(<Provider store={store}><DebugSessionProvider><Probe active={active} /></DebugSessionProvider></Provider>)
    await Promise.resolve()
  })
  await render()
  return { store, host, render, get current() { return current }, switchSession: async (id: string) => act(async () => { store.set(activeSessionIdAtom, id); await Promise.resolve() }) }
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}

async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === text)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

describe('DebugSessionProvider session and pagination ownership', () => {
  test('aborts an old session read and ignores its late response after the next session loads', async () => {
    const pending = deferredFetch()
    const view = await mount()
    expect(view.current.loading).toBe(true)
    await view.switchSession('b')
    expect(pending[0]!.signal.aborted).toBe(true)
    await act(async () => pending[1]!.resolve(page('b', [turn('b-turn', 0, 'b')])))
    expect(view.current.turns.map(value => value.id)).toEqual(['b-turn'])
    await act(async () => pending[0]!.resolve(page('a', [turn('a-turn', 0)])))
    expect(view.current.sessionId).toBe('b')
    expect(view.current.records.rounds.every(value => value.sessionId === 'b')).toBe(true)
    expect(view.current.loading).toBe(false)
  })

  test('clears selection/reveal across A to B to A and rejects stale callbacks and foreign rounds', async () => {
    databaseFetch(() => [turn('a-turn', 0), turn('b-turn', 0, 'b')])
    const view = await mount()
    const previous = view.current
    const oldRound = previous.records.rounds[0]!
    await act(async () => { previous.inspect('rounds', oldRound.id); previous.locate(oldRound) })
    expect(view.current.selection?.id).toBe(oldRound.id)
    expect(view.current.reveal?.turnId).toBe('a-turn')
    await view.switchSession('b')
    await act(async () => { previous.inspect('rounds', oldRound.id); previous.locate(oldRound); view.current.locate(oldRound) })
    expect(view.current.selection).toBeNull()
    expect(view.current.reveal).toBeNull()
    await view.switchSession('a')
    expect(view.current.selection).toBeNull()
    expect(view.current.reveal).toBeNull()
  })

  test('refreshes through the previously loaded boundary after new head Turns move old records to another page', async () => {
    let rows = [turn('t1', 0), turn('t2', 1), turn('t3', 2), turn('t4', 3), turn('t5', 4), turn('t6', 5)]
    const requests = databaseFetch(() => rows)
    const view = await mount()
    expect(view.current.turns.map(value => value.id)).toEqual(['t6', 't5'])
    await act(async () => view.current.loadMore())
    expect(view.current.turns.map(value => value.id)).toEqual(['t6', 't5', 't4', 't3'])
    const inspected = view.current.records.rounds.find(value => value.turnId === 't3')!
    await act(async () => view.current.inspect('rounds', inspected.id))
    rows = [...rows.filter(value => value.id !== 't3'), turn('t3', 2, 'a', 'Updated stored body'), turn('t7', 6)]
    const before = requests.length
    await act(async () => view.current.refresh())
    expect(requests.length - before).toBe(3)
    expect(view.current.records.rounds.find(value => value.turnId === 't3')).toMatchObject({ id: inspected.id, body: 'Updated stored body' })
    expect(view.current.selection?.id).toBe(inspected.id)
    expect(new Set(view.current.turns.map(value => value.id)).size).toBe(view.current.turns.length)
  })

  test('rejects cross-session response data and clears a removed selected record after a valid refresh', async () => {
    const pending = deferredFetch()
    const view = await mount()
    await act(async () => pending[0]!.resolve(page('a', [turn('a-turn', 0)])))
    await act(async () => view.current.inspect('rounds', view.current.records.rounds[0]!.id))
    await act(async () => view.current.refresh())
    await act(async () => pending[1]!.resolve(page('a', [turn('foreign', 0, 'b')])))
    expect(view.current.error).toBe('Invalid session trace response')
    expect(view.current.turns.map(value => value.id)).toEqual(['a-turn'])
    await act(async () => view.current.refresh())
    await act(async () => pending[2]!.resolve(page('a', [])))
    expect(view.current.error).toBeNull()
    expect(view.current.selection).toBeNull()
    expect(view.current.records.rounds).toHaveLength(0)
  })
})

describe('DebugPanel filters and inspection', () => {
  test('filters actual unknown/error results, resets filters for inspect, and keeps detail across hide/show', async () => {
    databaseFetch(() => [turn('alpha', 0)])
    const view = await mount('tools')
    expect(view.host.querySelectorAll('[data-debug-record]')).toHaveLength(3)
    expect(view.host.textContent).toContain('Turn 1')
    const status = view.host.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!
    await choose(status, 'unknown')
    expect(view.host.querySelectorAll('[data-debug-record]')).toHaveLength(1)
    expect(view.host.textContent).toContain('alpha-missing')
    await choose(view.host.querySelector<HTMLSelectElement>('select[aria-label="Filter by tool"]')!, 'write_file')
    expect(view.host.querySelectorAll('[data-debug-record]')).toHaveLength(0)
    const call = view.current.records.calls.find(value => value.sourceCallId === 'alpha-success')!
    await act(async () => view.current.inspect('tools', call.id))
    expect(view.host.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!.value).toBe('all')
    expect(view.host.querySelector<HTMLSelectElement>('select[aria-label="Filter by tool"]')!.value).toBe('')
    const card = [...view.host.querySelectorAll<HTMLButtonElement>('[data-debug-record]')].find(value => value.dataset.debugRecord === call.id)!
    expect(card.classList.contains('is-focused')).toBe(true)
    await act(async () => card.click())
    const argumentsRecord = [...view.host.querySelectorAll('details')].find(value => value.querySelector('summary')?.textContent === 'Arguments')!
    expect(argumentsRecord.querySelector('pre')!.textContent).toContain('"name": "path"')
    const resultRecord = [...view.host.querySelectorAll('details')].find(value => value.querySelector('summary')?.textContent === 'Result')!
    expect(resultRecord.querySelector('pre')!.textContent).toBe('""')
    await view.render(false)
    await view.render(true)
    expect(view.host.querySelector('.debug-detail h3')?.textContent).toBe('read_file')
    const nonce = view.current.selection!.nonce
    await act(async () => view.current.inspect('tools', call.id))
    expect(view.current.selection!.nonce).toBeGreaterThan(nonce)
    expect(view.host.querySelector('.debug-detail')).toBeNull()
    expect(view.host.querySelector('.debug-record-card.is-focused')?.getAttribute('data-debug-record')).toBe(call.id)
  })

  test('clears stale details and removed tool filters without reopening a returning record', async () => {
    let rows = [turn('alpha', 0)]
    databaseFetch(() => rows)
    const view = await mount('tools')
    await choose(view.host.querySelector<HTMLSelectElement>('select[aria-label="Filter by tool"]')!, 'write_file')
    await act(async () => view.host.querySelector<HTMLButtonElement>('[data-debug-record]')!.click())
    rows = []
    await act(async () => view.current.refresh())
    expect(view.host.querySelector('.debug-detail')).toBeNull()
    expect(view.host.querySelector<HTMLSelectElement>('select[aria-label="Filter by tool"]')!.value).toBe('')
    rows = [turn('alpha', 0)]
    await act(async () => view.current.refresh())
    expect(view.host.querySelector('.debug-detail')).toBeNull()
    expect(view.host.querySelectorAll('[data-debug-record]')).toHaveLength(3)
  })

  test('shows missing prompts honestly and keeps recorded raw values available in round details', async () => {
    const stored = turn('alpha', 0)
    databaseFetch(() => [stored])
    const view = await mount('rounds')
    await act(async () => view.host.querySelector<HTMLButtonElement>('[data-debug-record]')!.click())
    await click(view.host, 'Model request')
    expect(view.host.textContent).toContain('did not retain the model request')
    await click(view.host, 'Raw record')
    expect(view.host.querySelector('[role="tabpanel"] pre')!.textContent).toContain('"think_scope"')
    expect(view.host.querySelector('[role="tabpanel"] pre')!.textContent).toContain('"tool_arguments": null')
    await click(view.host, 'Locate in chat')
    expect(view.current.reveal).toMatchObject({ sessionId: 'a', turnId: 'alpha' })
    await view.switchSession('b')
    expect(view.host.querySelector('.debug-detail')).toBeNull()
    expect(view.current.reveal).toBeNull()
  })
})

describe('DebugRoundsPanel Turn grouping', () => {
  function groupedTurns(): DesktopDebugTurn[] {
    const first = turn('plan-turn', 0)
    first.userInput = { text: 'Plan the launch agenda', blocks: [{ type: 'text', value: 'Plan the launch agenda' }] }
    first.otaRecords = [
      { think_scope: { mode: 'main', stage: 'main' }, think_result: { step_content: 'Outlined the launch agenda', tool_calls: [] } },
      { think_scope: { mode: 'main', stage: 'main' }, think_result: { step_content: '', tool_calls: [
        { call_id: 'read-agenda', tool: 'read_file', tool_arguments: {} },
        { call_id: 'save-agenda', tool: 'write_file', tool_arguments: {} },
      ] } },
    ]
    const second = turn('budget-turn', 1)
    second.userInput = { text: 'Reconcile the budget totals', blocks: [{ type: 'text', value: 'Reconcile the budget totals' }] }
    second.otaRecords = [
      { think_scope: { mode: 'main', stage: 'main' }, think_result: { step_content: 'Drafted the budget report', tool_calls: [] } },
      { think_scope: { mode: 'main', stage: 'main' }, think_result: { step_content: 'Checked all budget totals', tool_calls: [] } },
    ]
    return [first, second]
  }

  async function search(host: HTMLElement, value: string) {
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Search user input, output or tools…"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  test('groups each Turn with its user input and independent ascending R01/R02 cards, newest Turn first', async () => {
    databaseFetch(groupedTurns)
    const view = await mount('rounds')
    const groups = [...view.host.querySelectorAll<HTMLDetailsElement>('[data-debug-turn]')]
    expect(groups.map(group => group.dataset.debugTurn)).toEqual(['budget-turn', 'plan-turn'])
    expect(groups.map(group => group.querySelector('.debug-turn-heading strong')?.textContent)).toEqual(['Turn 2', 'Turn 1'])
    expect(groups.map(group => group.querySelector('.debug-turn-input')?.textContent)).toEqual(['Reconcile the budget totals', 'Plan the launch agenda'])
    expect(groups.map(group => [...group.querySelectorAll('.debug-record-card strong code')].map(code => code.textContent))).toEqual([['R01', 'R02'], ['R01', 'R02']])
    expect(groups.map(group => [...group.querySelectorAll<HTMLElement>('[data-debug-record]')].map(card => card.dataset.debugRecord))).toEqual([
      ['budget-turn:round:1', 'budget-turn:round:2'], ['plan-turn:round:1', 'plan-turn:round:2'],
    ])
    const cards = [...view.host.querySelectorAll<HTMLElement>('[data-debug-record]')]
    expect(cards.map(card => card.querySelector('.debug-round-excerpt')?.textContent)).toEqual([
      'Drafted the budget report', 'Checked all budget totals', 'Outlined the launch agenda', 'Returned tool calls',
    ])
    expect(cards[3]!.querySelector('.debug-round-tools')?.textContent).toContain('read_file · write_file')
    expect(view.host.querySelector('.debug-round-stage')).toBeNull()
  })

  test('opens the second Turn R01 with its own saved input/output and locates that exact Turn', async () => {
    databaseFetch(groupedTurns)
    const view = await mount('rounds')
    const secondTurnCard = view.host.querySelector<HTMLButtonElement>('[data-debug-turn="budget-turn"] [data-debug-record="budget-turn:round:1"]')!
    await act(async () => secondTurnCard.click())
    expect(view.host.querySelector('.debug-detail h3 code')?.textContent).toBe('R01')
    expect(view.host.querySelector('.debug-turn-context p')?.textContent).toBe('Reconcile the budget totals')
    expect(view.host.querySelector('.debug-detail [role="tabpanel"]')?.textContent).toContain('Drafted the budget report')
    expect(view.host.querySelector('.debug-detail')?.textContent).not.toContain('Plan the launch agenda')
    await click(view.host, 'Locate in chat')
    expect(view.current.reveal).toMatchObject({ turnId: 'budget-turn', targetId: 'desktop-debug-round-budget-turn%3Around%3A1' })
    await click(view.host, 'Back to list')
    await act(async () => view.host.querySelector<HTMLButtonElement>('[data-debug-record="plan-turn:round:1"]')!.click())
    expect(view.host.querySelector('.debug-turn-context p')?.textContent).toBe('Plan the launch agenda')
    expect(view.host.querySelector('.debug-detail [role="tabpanel"]')?.textContent).toContain('Outlined the launch agenda')
  })

  test('external inspect expands the exact collapsed Turn group and focuses its saved round identity', async () => {
    databaseFetch(groupedTurns)
    const view = await mount('rounds')
    const group = view.host.querySelector<HTMLDetailsElement>('[data-debug-turn="plan-turn"]')!
    const otherGroup = view.host.querySelector<HTMLDetailsElement>('[data-debug-turn="budget-turn"]')!
    group.open = false
    otherGroup.open = false
    const round = view.current.records.rounds.find(value => value.turnId === 'plan-turn' && value.ordinal === 2)!
    await act(async () => view.current.inspect('rounds', round.id))
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
    expect(group.open).toBe(true)
    expect(otherGroup.open).toBe(false)
    const focused = view.host.querySelector<HTMLElement>('.debug-record-card.is-focused')!
    expect(focused.dataset.debugRecord).toBe('plan-turn:round:2')
    expect(focused.closest<HTMLElement>('[data-debug-turn]')?.dataset.debugTurn).toBe('plan-turn')
    expect(document.activeElement).toBe(focused)
  })

  test('searches saved user input within the correct Turn and retains original round ordinals for output matches', async () => {
    databaseFetch(groupedTurns)
    const view = await mount('rounds')
    await search(view.host, 'RECONCILE THE BUDGET')
    expect([...view.host.querySelectorAll<HTMLElement>('[data-debug-turn]')].map(group => group.dataset.debugTurn)).toEqual(['budget-turn'])
    expect([...view.host.querySelectorAll('.debug-record-card strong code')].map(code => code.textContent)).toEqual(['R01', 'R02'])
    await search(view.host, 'Checked all budget totals')
    expect([...view.host.querySelectorAll<HTMLElement>('[data-debug-record]')].map(card => card.dataset.debugRecord)).toEqual(['budget-turn:round:2'])
    expect(view.host.querySelector('.debug-record-card strong code')?.textContent).toBe('R02')
    await search(view.host, 'write_file')
    expect([...view.host.querySelectorAll<HTMLElement>('[data-debug-turn]')].map(group => group.dataset.debugTurn)).toEqual(['plan-turn'])
    expect(view.host.querySelector<HTMLElement>('[data-debug-record]')?.dataset.debugRecord).toBe('plan-turn:round:2')
    await search(view.host, '')
    expect(view.host.querySelectorAll('[data-debug-turn]')).toHaveLength(2)
  })
})

describe('DebugRoundsPanel stage filters', () => {
  function stagedTurns(sessionId = 'a'): DesktopDebugTurn[] {
    const first = turn(`${sessionId}-launch`, 0, sessionId)
    first.userInput = { text: 'Launch planning task' }
    const second = turn(`${sessionId}-budget`, 1, sessionId)
    second.userInput = { text: 'Budget reconciliation task' }
    const record = (mode: string, stage: string, body: string) => ({ think_scope: { mode, stage }, think_result: { step_content: body, tool_calls: [] } })
    first.otaRecords = [record('normal', 'main', 'General chat reply'), record('build', 'plan', 'Build launch outline'), record('workflow', 'plan', 'Workflow launch outline')]
    second.otaRecords = [record('build', 'plan', 'Build budget outline'), record('workflow', 'plan', 'Workflow budget outline'), record('build', 'review', 'Final budget review')]
    return [first, second]
  }

  function stageGroup(host: HTMLElement) {
    return host.querySelector<HTMLElement>('[role="tablist"][aria-label="Filter by stage"]')!
  }

  async function selectStage(host: HTMLElement, label: string) {
    const button = [...stageGroup(host).querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === label)
    expect(button).toBeDefined()
    await act(async () => button!.click())
    expect(button!.getAttribute('aria-selected')).toBe('true')
  }

  function recordIds(host: HTMLElement) {
    return [...host.querySelectorAll<HTMLElement>('[data-debug-record]')].map(card => card.dataset.debugRecord)
  }

  async function setSearch(host: HTMLElement, value: string) {
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Search user input, output or tools…"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  test('isolates the exact mode and stage pair when different modes share a stage name', async () => {
    databaseFetch(() => {
      const turns = stagedTurns()
      const presentation = turns[1]!
      presentation.otaRecords = [...presentation.otaRecords as unknown[],
        { think_scope: { mode: 'presentation', stage: 'ppt_brief' }, think_result: { step_content: 'Recorded brief', tool_calls: [] } },
        { think_scope: { mode: 'presentation', stage: 'ppt_plan' }, think_result: { step_content: 'Recorded plan', tool_calls: [] } },
      ]
      return turns
    })
    const view = await mount('rounds')
    expect(recordIds(view.host)).toHaveLength(8)
    const labels = [...stageGroup(view.host).querySelectorAll('[role="tab"]')].map(tab => tab.textContent)
    expect(labels).toContain('main')
    expect(labels).toContain('ppt_brief')
    expect(labels).toContain('ppt_plan')
    expect(labels).not.toContain('General chat')
    expect(stageGroup(view.host).querySelector('[aria-selected="true"]')?.textContent).toBe('All stages')
    await selectStage(view.host, 'plan · build')
    expect(recordIds(view.host)).toEqual(['a-budget:round:1', 'a-launch:round:2'])
    await selectStage(view.host, 'plan · workflow')
    expect(recordIds(view.host)).toEqual(['a-budget:round:2', 'a-launch:round:3'])
    expect(stageGroup(view.host).querySelectorAll('[aria-selected="true"]')).toHaveLength(1)
    await selectStage(view.host, 'main')
    expect(recordIds(view.host)).toEqual(['a-launch:round:1'])
    await selectStage(view.host, 'ppt_brief')
    expect(recordIds(view.host)).toEqual(['a-budget:round:4'])
    await selectStage(view.host, 'ppt_plan')
    expect(recordIds(view.host)).toEqual(['a-budget:round:5'])
  })

  test('combines stage selection with user-input and output search without renumbering Turns or rounds', async () => {
    databaseFetch(stagedTurns)
    const view = await mount('rounds')
    const stageOptions = [...stageGroup(view.host).querySelectorAll('[role="tab"]')].map(tab => tab.textContent)
    await selectStage(view.host, 'plan · build')
    await setSearch(view.host, 'BUDGET RECONCILIATION')
    expect(recordIds(view.host)).toEqual(['a-budget:round:1'])
    expect(view.host.querySelector('.debug-turn-heading strong')?.textContent).toBe('Turn 2')
    await setSearch(view.host, 'Build launch outline')
    expect(recordIds(view.host)).toEqual(['a-launch:round:2'])
    expect(view.host.querySelector('.debug-turn-heading strong')?.textContent).toBe('Turn 1')
    expect(view.host.querySelector('.debug-record-card strong code')?.textContent).toBe('R02')
    await setSearch(view.host, 'Workflow launch outline')
    expect(recordIds(view.host)).toHaveLength(0)
    expect(stageGroup(view.host).querySelector('[aria-selected="true"]')?.textContent).toBe('plan · build')
    expect([...stageGroup(view.host).querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(stageOptions)
  })

  test('external inspection clears stage and text filters so a round from another mode becomes visible', async () => {
    databaseFetch(stagedTurns)
    const view = await mount('rounds')
    await selectStage(view.host, 'plan · build')
    await setSearch(view.host, 'Budget reconciliation')
    const target = view.current.records.rounds.find(value => value.turnId === 'a-launch' && value.ordinal === 3)!
    await act(async () => view.current.inspect('rounds', target.id))
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
    expect(stageGroup(view.host).querySelector('[aria-selected="true"]')?.textContent).toBe('All stages')
    expect(view.host.querySelector<HTMLInputElement>('input')!.value).toBe('')
    expect(recordIds(view.host)).toHaveLength(6)
    const focused = view.host.querySelector<HTMLElement>('.debug-record-card.is-focused')!
    expect(focused.dataset.debugRecord).toBe('a-launch:round:3')
    expect(document.activeElement).toBe(focused)
  })

  test('switching sessions resets the selected stage even when both sessions contain that stage', async () => {
    databaseFetch(() => [...stagedTurns('a'), ...stagedTurns('b')])
    const view = await mount('rounds')
    await selectStage(view.host, 'plan · workflow')
    await view.switchSession('b')
    expect(stageGroup(view.host).querySelector('[aria-selected="true"]')?.textContent).toBe('All stages')
    expect(recordIds(view.host)).toHaveLength(6)
    expect(recordIds(view.host).every(id => id?.startsWith('b-'))).toBe(true)
  })
})
