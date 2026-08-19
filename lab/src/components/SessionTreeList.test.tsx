import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionSummary } from '../api'
import { buildSessionTree, SessionTreeList } from './SessionTreeList'

function session(id: string, parentSessionId: string | null, title: string): SessionSummary {
  return {
    id,
    title,
    status: 'completed',
    kind: 'user',
    parentSessionId,
    parentCallId: parentSessionId ? `call-${id}` : null,
    subagentMode: parentSessionId ? 'blocking' : null,
    workspaceRoot: `/tmp/${id}`,
    scheduleId: null,
    lastUsedModel: 'gpt-5',
    lastAnswer: null,
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T00:00:00Z',
    turnCount: 1,
    inputTokens: 10,
    outputTokens: 2,
  }
}

describe('SessionTreeList', () => {
  const sessions = [
    session('root', null, 'Root session'),
    session('child', 'root', 'Child session'),
    session('grandchild', 'child', 'Needle investigation'),
    session('sibling', 'root', 'Sibling session'),
    session('orphan', 'missing', 'Orphan session'),
  ]

  test('groups descendants under their root in a stable two-level tree', () => {
    const trees = buildSessionTree(sessions)

    expect(trees.map((tree) => tree.root.id)).toEqual(['root', 'orphan'])
    expect(trees[0]?.children.map((child) => child.id)).toEqual(['child', 'grandchild', 'sibling'])
    expect(trees[1]?.children).toEqual([])
  })

  test('keeps and expands the path to matching child sessions', () => {
    const trees = buildSessionTree(sessions, 'needle')

    expect(trees).toHaveLength(1)
    expect(trees[0]?.root.id).toBe('root')
    expect(trees[0]?.children.map((child) => child.id)).toEqual(['grandchild'])
    expect(trees[0]?.expandForSearch).toBe(true)
  })

  test('renders search matches as an expanded accessible tree', () => {
    const markup = renderToStaticMarkup(
      <SessionTreeList sessions={sessions} query="needle" defaultExpanded={false} />,
    )

    expect(markup).toContain('role="tree"')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Root session')
    expect(markup).toContain('Needle investigation')
    expect(markup).not.toContain('Sibling session')
  })

  test('keeps a selected child visible when groups are collapsed by default', () => {
    const markup = renderToStaticMarkup(
      <SessionTreeList sessions={sessions} selectedSessionId="child" defaultExpanded={false} />,
    )

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Child session')
  })
})
