import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../i18n'
import { DebugWorkbenchPanel } from './DebugWorkbenchPanel'
import { buildDebugRecords } from './debug-records'
import { createDebugSimulationReceipt, emptyDebugFilters, filterDebugCalls, filterDebugRounds, isValidRoundRequest, nextDebugRoundTab, parseDebugArguments, roundRequest } from './debug-panel-state'
import { getDemoScenarios } from './demo-data'
import { createExperimentPreviewState } from './experiment-state'
import { getPresentationTrace } from './presentation-trace-data'

const scenario = getDemoScenarios('en-US')[0]!
const session = createExperimentPreviewState().modes.find(mode => mode.id === 'presentation')!.sessions[0]!
const records = buildDebugRecords(session, scenario, getPresentationTrace('en-US'), 'en-US')

describe('debug request previews', () => {
  test('rejects invalid JSON and non-object arguments before a tool preview can be created', () => {
    for (const input of ['null', '[]', '42', '"query"', 'true']) expect(parseDebugArguments(input)).toEqual({ ok: false, error: 'object-required' })
    expect(parseDebugArguments('{"query":')).toEqual({ ok: false, error: 'invalid-json' })
    expect(parseDebugArguments('{"query":"updated","count":2}')).toEqual({ ok: true, value: { query: 'updated', count: 2 } })
  })

  test('requires a valid message envelope for a round preview and preserves missing model values', () => {
    const request = roundRequest(records.rounds[0]!)
    expect(isValidRoundRequest(request)).toBe(true)
    expect(request.model).toBeNull()
    expect(isValidRoundRequest({ ...request, messages: [] })).toBe(false)
    expect(isValidRoundRequest({ ...request, messages: [{ role: 'made-up', content: 'hi' }] })).toBe(false)
    expect(isValidRoundRequest({ ...request, tools: null })).toBe(false)
  })

  test('new mock attempts snapshot edited parameters without overwriting or impersonating original results', () => {
    const call = records.calls[0]!
    const original = JSON.stringify(call)
    const changed = { tool: call.name, arguments: { goal: 'New test', nested: { enabled: true } } }
    const first = createDebugSimulationReceipt('tool', call.id, changed, 'preview-1', 1000)
    changed.arguments.nested.enabled = false
    const second = createDebugSimulationReceipt('tool', call.id, changed, 'preview-2', 2000)
    expect(first.request.arguments).toEqual({ goal: 'New test', nested: { enabled: true } })
    expect(second.request.arguments).toEqual({ goal: 'New test', nested: { enabled: false } })
    expect(first.id).not.toBe(second.id)
    expect(first.executed).toBe(false)
    expect(first).not.toHaveProperty('result')
    expect(JSON.stringify(call)).toBe(original)
  })
})

describe('debug record lists', () => {
  test('round tabs support roving arrows, wrapping and first/last navigation without intercepting Tab', () => {
    expect(nextDebugRoundTab('request', 'ArrowRight')).toBe('response')
    expect(nextDebugRoundTab('state', 'ArrowRight')).toBe('request')
    expect(nextDebugRoundTab('request', 'ArrowLeft')).toBe('state')
    expect(nextDebugRoundTab('response', 'Home')).toBe('request')
    expect(nextDebugRoundTab('request', 'End')).toBe('state')
    expect(nextDebugRoundTab('request', 'Tab')).toBeNull()
  })

  test('combines tool name, query, status and execution filters instead of searching another execution', () => {
    const failed = records.calls.find(call => call.status === 'error')!
    const filter = { ...emptyDebugFilters, name: failed.name, status: 'error' as const, turnId: failed.turnId }
    const selected = filterDebugCalls(records.calls, filter)
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.every(call => call.name === failed.name && call.status === 'error')).toBe(true)
    expect(filterDebugCalls(records.calls, { ...filter, turnId: 'other-session' })).toEqual([])
    expect(filterDebugCalls(records.calls, { ...filter, query: 'not-found' })).toEqual([])
    expect(filterDebugCalls(records.calls, emptyDebugFilters)).toContain(failed)
  })

  test('round search includes stable round labels and remains scoped to an execution', () => {
    expect(filterDebugRounds(records.rounds, { ...emptyDebugFilters, query: 'r10' }).map(round => round.sourceRoundId)).toEqual(['R10'])
    expect(filterDebugRounds(records.rounds, { ...emptyDebugFilters, query: 'r10', turnId: 'different-turn' })).toEqual([])
  })

  test('tool list exposes all calls with provenance and does not fabricate duration', async () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en-US"><DebugWorkbenchPanel sessionId={session.id} surface="tools" records={records} request={null} onLocateRound={() => {}} /></I18nProvider>)
    const ids: Array<string | null> = []
    await new HTMLRewriter().on('[data-debug-call-id]', { element: element => { ids.push(element.getAttribute('data-debug-call-id')) } }).transform(new Response(html)).text()
    expect(ids).toHaveLength(records.calls.length)
    expect(new Set(ids).size).toBe(records.calls.length)
    expect(html).toContain('Filter by tool name')
    expect(html).toContain('Frontend samples')
    expect(html).toContain('Not recorded')
    expect(html).not.toContain('引用')
  })

  test('round list exposes complete round navigation rather than grouping by tool name', async () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh-CN"><DebugWorkbenchPanel surface="rounds" records={records} request={null} onLocateRound={() => {}} /></I18nProvider>)
    const ids: Array<string | null> = []
    await new HTMLRewriter().on('[data-debug-round-id]', { element: element => { ids.push(element.getAttribute('data-debug-round-id')) } }).transform(new Response(html)).text()
    expect(ids).toHaveLength(10)
    expect(html).toContain('10 轮')
    expect(html).not.toContain('按工具名称筛选')
    expect(html).toContain('R10')
    expect(html).toContain('含失败调用')
    expect(html).toContain('本轮完成')
    expect(html).toContain('3 失败')
  })
})
