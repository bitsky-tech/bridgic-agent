import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { SessionSummary } from '../api'
import './SessionTreeList.css'

export interface SessionTreeNode {
  root: SessionSummary
  children: SessionSummary[]
  rootMatches: boolean
  matchingChildIds: string[]
  expandForSearch: boolean
}

export interface SessionTreeRenderState {
  child: boolean
  selected: boolean
  matched: boolean
}

export interface SessionTreeListLabels {
  tree: string
  untitled: string
  expand: string
  collapse: string
  noResults: string
}

export interface SessionTreeListProps {
  sessions: readonly SessionSummary[]
  selectedSessionId?: string | null
  query?: string
  defaultExpanded?: boolean
  defaultExpandedRootIds?: readonly string[]
  expandedRootIds?: readonly string[]
  labels?: Partial<SessionTreeListLabels>
  className?: string
  emptyState?: ReactNode
  renderSession?: (session: SessionSummary, state: SessionTreeRenderState) => ReactNode
  onSelectSession?: (session: SessionSummary) => void
  onExpandedRootIdsChange?: (rootIds: string[]) => void
}

const defaultLabels: SessionTreeListLabels = {
  tree: 'Sessions',
  untitled: 'Untitled session',
  expand: 'Expand child sessions',
  collapse: 'Collapse child sessions',
  noResults: 'No matching sessions',
}

function searchableText(session: SessionSummary): string {
  return [
    session.title,
    session.id,
    session.kind,
    session.subagentMode,
    session.lastUsedModel,
    session.lastAnswer,
    session.workspaceRoot,
    session.parentCallId,
    session.scheduleId,
  ].filter((value): value is string => typeof value === 'string').join(' ').toLocaleLowerCase()
}

function resolveRootId(
  start: SessionSummary,
  sessionsById: ReadonlyMap<string, SessionSummary>,
): string {
  const lineage: string[] = []
  const positions = new Map<string, number>()
  let current = start

  while (true) {
    const cycleAt = positions.get(current.id)
    if (cycleAt !== undefined) {
      return [...lineage.slice(cycleAt)].sort((left, right) => left.localeCompare(right))[0] ?? start.id
    }
    positions.set(current.id, lineage.length)
    lineage.push(current.id)

    const parentId = current.parentSessionId
    const parent = parentId ? sessionsById.get(parentId) : undefined
    if (!parent) return current.id
    current = parent
  }
}

/** Groups every descendant below its root so the rendered tree remains two levels deep. */
export function buildSessionTree(sessions: readonly SessionSummary[], query = ''): SessionTreeNode[] {
  const uniqueSessions: SessionSummary[] = []
  const sessionsById = new Map<string, SessionSummary>()
  for (const session of sessions) {
    if (sessionsById.has(session.id)) continue
    sessionsById.set(session.id, session)
    uniqueSessions.push(session)
  }

  const groups = new Map<string, SessionSummary[]>()
  for (const session of uniqueSessions) {
    const rootId = resolveRootId(session, sessionsById)
    const group = groups.get(rootId)
    if (group) group.push(session)
    else groups.set(rootId, [session])
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const order = new Map(uniqueSessions.map((session, index) => [session.id, index]))
  return [...groups.entries()]
    .sort(([left], [right]) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
    .flatMap(([rootId, group]) => {
      const root = sessionsById.get(rootId)
      if (!root) return []
      const allChildren = group.filter((session) => session.id !== rootId)
      if (!normalizedQuery) {
        return [{
          root,
          children: allChildren,
          rootMatches: false,
          matchingChildIds: [],
          expandForSearch: false,
        }]
      }

      const rootMatches = searchableText(root).includes(normalizedQuery)
      const matchingChildren = allChildren.filter((session) =>
        searchableText(session).includes(normalizedQuery))
      if (!rootMatches && matchingChildren.length === 0) return []
      return [{
        root,
        children: rootMatches ? allChildren : matchingChildren,
        rootMatches,
        matchingChildIds: matchingChildren.map((session) => session.id),
        expandForSearch: matchingChildren.length > 0,
      }]
    })
}

function defaultSessionContent(
  session: SessionSummary,
  state: SessionTreeRenderState,
  untitled: string,
) {
  return (
    <>
      <span
        className={`session-tree-status session-tree-status-${session.status.replace(/[^a-z0-9_-]/gi, '-')}`}
        aria-hidden="true"
      />
      <span className="session-tree-copy">
        <strong>
          {state.child && <span className="session-tree-branch" aria-hidden="true">↳</span>}
          {session.title || session.id || untitled}
        </strong>
        <span>
          {state.child ? session.subagentMode || 'child' : session.kind}
          {session.lastUsedModel ? ` · ${session.lastUsedModel}` : ''}
        </span>
      </span>
      <span className="session-tree-count" aria-label={`${session.turnCount}`}>
        {session.turnCount}
      </span>
    </>
  )
}

export function SessionTreeList({
  sessions,
  selectedSessionId = null,
  query = '',
  defaultExpanded = true,
  defaultExpandedRootIds,
  expandedRootIds,
  labels: labelOverrides,
  className = '',
  emptyState,
  renderSession,
  onSelectSession,
  onExpandedRootIdsChange,
}: SessionTreeListProps) {
  const labels = { ...defaultLabels, ...labelOverrides }
  const trees = useMemo(() => buildSessionTree(sessions, query), [query, sessions])
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(() => {
    if (defaultExpandedRootIds) return new Set(defaultExpandedRootIds)
    if (!defaultExpanded) {
      const selectedRoot = buildSessionTree(sessions).find((tree) =>
        tree.children.some((child) => child.id === selectedSessionId))
      return new Set(selectedRoot ? [selectedRoot.root.id] : [])
    }
    return new Set(buildSessionTree(sessions).filter((tree) => tree.children.length > 0).map((tree) => tree.root.id))
  })
  const knownExpandableRootIds = useRef(new Set(
    buildSessionTree(sessions).filter((tree) => tree.children.length > 0).map((tree) => tree.root.id),
  ))
  const controlledExpanded = useMemo(
    () => expandedRootIds === undefined ? null : new Set(expandedRootIds),
    [expandedRootIds],
  )
  const expanded = controlledExpanded ?? internalExpanded

  useEffect(() => {
    if (!defaultExpanded || defaultExpandedRootIds || controlledExpanded !== null) return
    const newExpandableRoots = trees.filter((tree) =>
      tree.children.length > 0 && !knownExpandableRootIds.current.has(tree.root.id))
    for (const tree of trees) {
      if (tree.children.length > 0) knownExpandableRootIds.current.add(tree.root.id)
    }
    if (newExpandableRoots.length === 0) return
    setInternalExpanded((current) => {
      const next = new Set(current)
      for (const tree of newExpandableRoots) next.add(tree.root.id)
      return next
    })
  }, [controlledExpanded, defaultExpanded, defaultExpandedRootIds, trees])

  useEffect(() => {
    if (controlledExpanded !== null || !selectedSessionId) return
    const selectedRoot = trees.find((tree) =>
      tree.children.some((child) => child.id === selectedSessionId))
    if (!selectedRoot) return
    setInternalExpanded((current) => {
      if (current.has(selectedRoot.root.id)) return current
      return new Set(current).add(selectedRoot.root.id)
    })
  }, [controlledExpanded, selectedSessionId, trees])

  const setRootExpanded = (rootId: string, nextExpanded: boolean) => {
    const next = new Set(expanded)
    if (nextExpanded) next.add(rootId)
    else next.delete(rootId)
    if (controlledExpanded === null) setInternalExpanded(next)
    onExpandedRootIdsChange?.([...next])
  }

  const rootKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    rootId: string,
    hasChildren: boolean,
    isExpanded: boolean,
  ) => {
    if (!hasChildren) return
    if (event.key === 'ArrowRight' && !isExpanded) {
      event.preventDefault()
      setRootExpanded(rootId, true)
    } else if (event.key === 'ArrowLeft' && isExpanded) {
      event.preventDefault()
      setRootExpanded(rootId, false)
    }
  }

  if (trees.length === 0) {
    return (
      <div className={`session-tree-empty ${className}`.trim()} role="status">
        {emptyState ?? labels.noResults}
      </div>
    )
  }

  return (
    <ul className={`session-tree-list ${className}`.trim()} role="tree" aria-label={labels.tree}>
      {trees.map((tree) => {
        const hasChildren = tree.children.length > 0
        const isExpanded = hasChildren && (tree.expandForSearch || expanded.has(tree.root.id))
        const selected = selectedSessionId === tree.root.id
        const title = tree.root.title || tree.root.id || labels.untitled
        const state: SessionTreeRenderState = {
          child: false,
          selected,
          matched: tree.rootMatches,
        }

        return (
          <li key={tree.root.id} role="none" className="session-tree-node">
            <div
              className={`session-tree-row session-tree-root${selected ? ' is-selected' : ''}`}
              role="treeitem"
              aria-level={1}
              aria-selected={selected}
              aria-expanded={hasChildren ? isExpanded : undefined}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="session-tree-toggle"
                  aria-label={`${isExpanded ? labels.collapse : labels.expand}: ${title}`}
                  aria-expanded={isExpanded}
                  onClick={() => setRootExpanded(tree.root.id, !isExpanded)}
                >
                  <span aria-hidden="true">{isExpanded ? '⌄' : '›'}</span>
                </button>
              ) : (
                <span className="session-tree-toggle-placeholder" aria-hidden="true" />
              )}
              <button
                type="button"
                className="session-tree-select"
                aria-pressed={selected}
                onClick={() => onSelectSession?.(tree.root)}
                onKeyDown={(event) => rootKeyDown(event, tree.root.id, hasChildren, isExpanded)}
              >
                {renderSession
                  ? renderSession(tree.root, state)
                  : defaultSessionContent(tree.root, state, labels.untitled)}
              </button>
            </div>

            {isExpanded && (
              <ul role="group" className="session-tree-children">
                {tree.children.map((child) => {
                  const childSelected = selectedSessionId === child.id
                  const childState: SessionTreeRenderState = {
                    child: true,
                    selected: childSelected,
                    matched: tree.matchingChildIds.includes(child.id),
                  }
                  return (
                    <li key={child.id} role="none">
                      <div
                        className={`session-tree-row session-tree-child${childSelected ? ' is-selected' : ''}`}
                        role="treeitem"
                        aria-level={2}
                        aria-selected={childSelected}
                      >
                        <span className="session-tree-toggle-placeholder" aria-hidden="true" />
                        <button
                          type="button"
                          className="session-tree-select"
                          aria-pressed={childSelected}
                          onClick={() => onSelectSession?.(child)}
                        >
                          {renderSession
                            ? renderSession(child, childState)
                            : defaultSessionContent(child, childState, labels.untitled)}
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
