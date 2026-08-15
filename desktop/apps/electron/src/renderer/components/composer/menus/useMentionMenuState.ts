/**
 * useMentionMenuState — session files, Workflow results, Workflows and schedules for the @ mention popover.
 *
 * The popover lists, in order, the current session's files, Workflow definitions, global Workflow results and
 * schedules, driven by the composer's @-filter in two modes:
 *   - Empty filter = TREE BROWSE: lazily read the session mounts level by level (the same hierarchy as the right panel).
 *     The root level is re-read every time the popover opens; expanding an unread folder reads exactly that level
 *     (`fs.listDir` + graft). There is no depth / size limit; oversized levels are paginated with an optional "load more" row.
 *   - Non-empty = SEARCH: debounced `fs.searchDir` — the main process walks names only (within a time budget) and returns
 *     ≤50 hits, so the whole tree never crosses the IPC boundary. `searchPartial` marks that the budget was exhausted.
 *
 * Living next to the menu (rather than being stuffed into FreeFormInput) keeps the host's size in check while the host still
 * OWNS keyboard selection: `rows` is a flat list of selectable rows in keyboard order — the menu renders strictly in that
 * order, so the index can never drift from what is on screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { DirTreeNode, SearchDirResult } from '@shared/dir-tree'
import type { FileSearchHit } from '@shared/file-search'
import { findNode } from '@/lib/fileTree'
import {
  loadMountLevelAtom,
  loadMountRootAtom,
  mountTreesAtom,
  mountsFamily,
} from '@/atoms/mounts'
import { rlog } from '@/lib/logger'
import { useDebouncedEffect } from '@/hooks/useDebouncedEffect'
import {
  hydrateWorkflowRunsAtom,
  hydrateWorkflowsAtom,
  workflowRunsAtom,
  workflowsAtom,
} from '@/atoms/workflows'
import { hydrateSchedulesAtom, schedulesAtom } from '@/atoms/schedules'
import type { WorkflowRunSummary, WorkflowSummary } from '@/lib/amphiClient'
import type { Schedule } from '@/lib/schedule'

/** Rows initially rendered per tree level; a "load more" row extends in steps. */
const BROWSE_PAGE = 200

/** Search debounce — coalesce per-keystroke queries before hitting the IPC. */
const SEARCH_DEBOUNCE_MS = 120

/** Keep repeated Workflow Runs from pushing Workflow definitions below the fold. */
const ALL_WORKFLOW_RUN_LIMIT = 3

/** Page the dedicated Workflow Run scope while keeping it useful for browsing. */
const WORKFLOW_RUN_PAGE = 20

/** Pagination key reserved for Workflow Runs; filesystem keys always contain a mount id. */
const WORKFLOW_RUNS_PAGE_KEY = 'workflow-runs'

export type MentionScope = 'all' | 'session-files' | 'workflow-runs' | 'workflows' | 'schedules'

/** One selectable popover row, discriminated by origin. */
export type MentionRow =
  | { kind: 'workflow-run'; run: WorkflowRunSummary }
  | { kind: 'workflow'; workflow: WorkflowSummary }
  | { kind: 'schedule'; schedule: Schedule }
  | { kind: 'scope-link'; scope: 'workflow-runs'; total: number }
  | {
      kind: 'tree'
      /** Unique across mounts: `${mountId}:${relPath}` ('' relPath = mount root). */
      key: string
      mountId: string
      nodeKind: 'file' | 'folder'
      name: string
      relPath: string
      depth: number
      expandable: boolean
      expanded: boolean
      /** Level read in flight (expanded, children not yet grafted). */
      loadingChildren: boolean
      sizeBytes: number | null
      unreadable: boolean
    }
  | { kind: 'search'; hit: FileSearchHit }
  /** Selectable pagination row — picking it reveals the level's next page. */
  | { kind: 'more'; key: string; remaining: number; section?: 'workflow-runs' }

/** Everything the menu renders from + the host's keyboard model reads. */
export interface MentionMenuState {
  /** 'search' iff the @-filter is non-empty; otherwise 'browse'. */
  mode: 'browse' | 'search'
  /** Resource family currently visible in the popover. */
  scope: MentionScope
  setScope: (scope: MentionScope) => void
  /** Flat, keyboard-ordered selectable rows. */
  rows: MentionRow[]
  /** Toggle a tree row's expansion (by its unique key) — lazily reads the
   *  level when it opens unloaded. */
  toggleExpand: (key: string) => void
  /** Reveal the next page of a windowed level (the 'more' row's action). */
  showMore: (key: string) => void
  /** Workflow result matches before the visible-row cap. */
  workflowRunTotal: number
  /** Workflow definition matches before the visible-row cap. */
  workflowTotal: number
  /** Schedule matches before the visible-row cap. */
  scheduleTotal: number
  /** Session file rows available in the current browse or search view. */
  sessionFileTotal: number
  /** Search walk hit its time budget — results may be incomplete. */
  searchPartial: boolean
  /** Root levels still loading, or a search query in flight. */
  loading: boolean
  /** No Workflow results or Session files are available. */
  empty: boolean
}

/** Derive the @ popover's rows/mode/flags from composer trigger state — see
 *  the file header for the browse × search model. */
export function useMentionMenuState(
  isOpen: boolean,
  filter: string,
  sessionId: string | null,
): MentionMenuState {
  const mounts = useAtomValue(mountsFamily(sessionId ?? ''))
  const trees = useAtomValue(mountTreesAtom)
  const loadRoot = useSetAtom(loadMountRootAtom)
  const loadLevel = useSetAtom(loadMountLevelAtom)
  const workflowRuns = useAtomValue(workflowRunsAtom)
  const workflows = useAtomValue(workflowsAtom)
  const schedules = useAtomValue(schedulesAtom)
  const hydrateWorkflowRuns = useSetAtom(hydrateWorkflowRunsAtom)
  const hydrateWorkflows = useSetAtom(hydrateWorkflowsAtom)
  const hydrateSchedules = useSetAtom(hydrateSchedulesAtom)

  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set())
  const [pageByKey, setPageByKey] = useState<ReadonlyMap<string, number>>(new Map())
  const [search, setSearch] = useState<SearchDirResult | null>(null)
  const [workflowSearchRuns, setWorkflowSearchRuns] = useState<WorkflowRunSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [runsLoading, setRunsLoading] = useState(false)
  const [runsSearching, setRunsSearching] = useState(false)
  const [scope, setScope] = useState<MentionScope>('all')

  // Open-edge effect: reset to collapsed state, and kick a FRESH one-level read
  // of every live folder mount root (snapshot semantics — never reuse a previous
  // open's data). Command-on-event, not derived state.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setExpandedKeys(new Set())
      setPageByKey(new Map())
      setScope('all')
      if (sessionId) {
        for (const m of mounts) {
          if (m.kind === 'folder' && m.exists) {
            void loadRoot({ sessionId, mountId: m.id, path: m.path })
          }
        }
      }
      setRunsLoading(true)
      Promise.all([hydrateWorkflows(), hydrateSchedules()])
        .catch((err: unknown) => rlog.warn('[mention] reference resources hydrate failed', err))
        .finally(() => setRunsLoading(false))
    }
    wasOpenRef.current = isOpen
  }, [isOpen, sessionId, mounts, loadRoot, hydrateWorkflows, hydrateSchedules])

  const mode: 'browse' | 'search' = filter.trim().length > 0 ? 'search' : 'browse'

  // Debounced main-process search. A stale response (older query) must not
  // overwrite a fresh one → seq guard (useDebouncedEffect only debounces the
  // trigger, not in-flight async results).
  const searchSeqRef = useRef(0)
  useDebouncedEffect(
    () => {
      if (!isOpen || mode !== 'search') return
      const seq = (searchSeqRef.current += 1)
      setSearching(true)
      const roots = mounts
        .filter((m) => m.exists)
        .map((m) => ({ mountId: m.id, mountName: m.name, absPath: m.path }))
      window.api.fs
        .searchDir({ roots, query: filter })
        .then((res) => {
          if (searchSeqRef.current !== seq) return
          setSearch(res)
          setSearching(false)
        })
        .catch((err: unknown) => {
          if (searchSeqRef.current !== seq) return
          rlog.warn('[mention] searchDir failed', err)
          setSearch({ hits: [], total: 0, partial: false })
          setSearching(false)
        })
    },
    [isOpen, mode, filter, mounts],
    SEARCH_DEBOUNCE_MS,
  )

  const runSearchSeqRef = useRef(0)
  useDebouncedEffect(
    () => {
      if (!isOpen || mode !== 'search') {
        runSearchSeqRef.current += 1
        setWorkflowSearchRuns([])
        setRunsSearching(false)
        return
      }
      const seq = (runSearchSeqRef.current += 1)
      setRunsSearching(true)
      hydrateWorkflowRuns({ query: filter.trim() })
        .then((runs) => {
          if (runSearchSeqRef.current !== seq) return
          setWorkflowSearchRuns(runs)
          setRunsSearching(false)
        })
        .catch((err: unknown) => {
          if (runSearchSeqRef.current !== seq) return
          rlog.warn('[mention] Workflow run search failed', err)
          setWorkflowSearchRuns([])
          setRunsSearching(false)
        })
    },
    [isOpen, mode, filter, hydrateWorkflowRuns],
    SEARCH_DEBOUNCE_MS,
  )

  const toggleExpand = (key: string): void => {
    const opening = !expandedKeys.has(key)
    if (opening) {
      // Freshness: every expansion re-reads this level. key = `${mountId}:${relPath}` (mount ids contain no
      // colon, so split on the first one); relPath '' = the mount root → re-read the root level.
      const sep = key.indexOf(':')
      const mountId = key.slice(0, sep)
      const relPath = key.slice(sep + 1)
      const mount = mounts.find((m) => m.id === mountId)
      if (mount) {
        if (relPath === '' && sessionId) {
          void loadRoot({ sessionId, mountId, path: mount.path })
        } else if (relPath !== '') {
          void loadLevel({ mountId, mountPath: mount.path, relPath })
        }
      }
    }
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Declarative self-healing: an expand marker exists but that level's content is missing (the snapshot was reset by the
  // other side, or a race) → read it again automatically. loadLevel/loadRoot dedupe in-flight requests; once children land
  // or the level is marked unreadable the effect converges, so a "permanently loading" state is mechanically impossible.
  useEffect(() => {
    if (!isOpen || mode !== 'browse') return
    for (const key of expandedKeys) {
      const sep = key.indexOf(':')
      const mountId = key.slice(0, sep)
      const relPath = key.slice(sep + 1)
      const mount = mounts.find((m) => m.id === mountId)
      if (!mount) continue
      const tree = trees[mountId]
      if (relPath === '') {
        if (tree === undefined && sessionId) {
          void loadRoot({ sessionId, mountId, path: mount.path })
        }
        continue
      }
      if (!tree?.ok) continue
      const node = findNode(tree.nodes, relPath)
      if (node && node.kind === 'folder' && !node.unreadable && node.children === undefined) {
        void loadLevel({ mountId, mountPath: mount.path, relPath })
      }
    }
  }, [isOpen, mode, expandedKeys, trees, mounts, sessionId, loadRoot, loadLevel])

  const showMore = (key: string): void => {
    setPageByKey((prev) => {
      const next = new Map(prev)
      const pageSize = key === WORKFLOW_RUNS_PAGE_KEY ? WORKFLOW_RUN_PAGE : BROWSE_PAGE
      next.set(key, (next.get(key) ?? pageSize) + pageSize)
      return next
    })
  }

  // Browse rows: preorder over each mount root + its expanded descendants —
  // MUST mirror the menu's render order (it renders from this list). Levels
  // window at BROWSE_PAGE rows with a selectable 'more' row.
  const browseRows = useMemo<MentionRow[]>(() => {
    const out: MentionRow[] = []
    const emitLevel = (
      mountId: string,
      levelKey: string,
      nodes: DirTreeNode[],
      depth: number,
    ): void => {
      const visible = pageByKey.get(levelKey) ?? BROWSE_PAGE
      for (const n of nodes.slice(0, visible)) {
        const key = `${mountId}:${n.relPath}`
        const expandable = n.kind === 'folder' && !n.unreadable
        const expanded = expandable && expandedKeys.has(key)
        out.push({
          kind: 'tree',
          key,
          mountId,
          nodeKind: n.kind,
          name: n.name,
          relPath: n.relPath,
          depth,
          expandable,
          expanded,
          loadingChildren: expanded && n.children === undefined,
          sizeBytes: n.sizeBytes,
          unreadable: n.unreadable === true,
        })
        if (expanded && n.children) emitLevel(mountId, key, n.children, depth + 1)
      }
      if (nodes.length > visible) {
        out.push({ kind: 'more', key: levelKey, remaining: nodes.length - visible })
      }
    }
    for (const m of mounts) {
      const rootKey = `${m.id}:`
      const tree = trees[m.id]
      const expandable = m.kind === 'folder' && m.exists
      const expanded = expandable && expandedKeys.has(rootKey)
      out.push({
        kind: 'tree',
        key: rootKey,
        mountId: m.id,
        nodeKind: m.kind,
        name: m.name,
        relPath: '',
        depth: 0,
        expandable,
        expanded,
        loadingChildren: expanded && tree === undefined,
        sizeBytes: m.kind === 'file' ? m.size_bytes : null,
        unreadable: false,
      })
      if (expanded && tree?.ok) emitLevel(m.id, rootKey, tree.nodes, 1)
    }
    return out
  }, [mounts, trees, expandedKeys, pageByKey])

  const searchRows = useMemo<MentionRow[]>(
    () => (search?.hits ?? []).map((hit) => ({ kind: 'search' as const, hit })),
    [search],
  )

  const matchedWorkflowRuns = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    return (mode === 'search' ? workflowSearchRuns : workflowRuns)
      .filter((run) => !query || [run.workflow_name, run.workflow_input.text, run.id]
        .some((value) => value.toLocaleLowerCase().includes(query)))
  }, [filter, mode, workflowRuns, workflowSearchRuns])

  const workflowRunRows = useMemo<MentionRow[]>(() => {
    const visible = pageByKey.get(WORKFLOW_RUNS_PAGE_KEY) ?? WORKFLOW_RUN_PAGE
    const rows: MentionRow[] = matchedWorkflowRuns
      .slice(0, visible)
      .map((run) => ({ kind: 'workflow-run' as const, run }))
    if (matchedWorkflowRuns.length > visible) {
      rows.push({
        kind: 'more',
        key: WORKFLOW_RUNS_PAGE_KEY,
        remaining: matchedWorkflowRuns.length - visible,
        section: 'workflow-runs',
      })
    }
    return rows
  }, [matchedWorkflowRuns, pageByKey])

  const allWorkflowRunRows = useMemo<MentionRow[]>(() => {
    const rows: MentionRow[] = workflowRunRows
      .filter((row) => row.kind === 'workflow-run')
      .slice(0, ALL_WORKFLOW_RUN_LIMIT)
    if (matchedWorkflowRuns.length > ALL_WORKFLOW_RUN_LIMIT) {
      rows.push({
        kind: 'scope-link',
        scope: 'workflow-runs',
        total: matchedWorkflowRuns.length,
      })
    }
    return rows
  }, [matchedWorkflowRuns.length, workflowRunRows])

  const matchedWorkflows = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    return workflows.filter((workflow) => !query || [workflow.name, workflow.desc ?? '', workflow.id]
      .some((value) => value.toLocaleLowerCase().includes(query)))
  }, [filter, workflows])

  const workflowRows = useMemo<MentionRow[]>(() => {
    const query = filter.trim().length > 0
    return matchedWorkflows
      .slice(0, query ? 20 : 8)
      .map((workflow) => ({ kind: 'workflow' as const, workflow }))
  }, [matchedWorkflows, filter])

  const matchedSchedules = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    return schedules.filter((schedule) => !query || [schedule.name, schedule.desc, schedule.id]
      .some((value) => value.toLocaleLowerCase().includes(query)))
  }, [filter, schedules])

  const scheduleRows = useMemo<MentionRow[]>(() => {
    const query = filter.trim().length > 0
    return matchedSchedules
      .slice(0, query ? 20 : 8)
      .map((schedule) => ({ kind: 'schedule' as const, schedule }))
  }, [matchedSchedules, filter])

  const sessionFileRows = mode === 'search' ? searchRows : browseRows
  let rows: MentionRow[] = [...sessionFileRows, ...workflowRows, ...allWorkflowRunRows, ...scheduleRows]
  if (scope === 'workflow-runs') rows = workflowRunRows
  else if (scope === 'session-files') rows = sessionFileRows
  else if (scope === 'workflows') rows = workflowRows
  else if (scope === 'schedules') rows = scheduleRows

  const folderMounts = mounts.filter((m) => m.kind === 'folder' && m.exists)
  const rootsLoading = isOpen && folderMounts.some((m) => trees[m.id] === undefined)
  const runsBusy = runsLoading || runsSearching
  const filesBusy = mode === 'search' ? searching : rootsLoading
  let loading = runsBusy || filesBusy
  if (scope === 'workflow-runs') loading = runsBusy
  else if (scope === 'session-files') loading = filesBusy
  else if (scope === 'workflows') loading = runsLoading
  else if (scope === 'schedules') loading = runsLoading

  return {
    mode,
    scope,
    setScope,
    rows,
    toggleExpand,
    showMore,
    workflowRunTotal: matchedWorkflowRuns.length,
    workflowTotal: matchedWorkflows.length,
    scheduleTotal: matchedSchedules.length,
    sessionFileTotal: mode === 'search'
      ? search?.total ?? 0
      : sessionFileRows.filter((row) => row.kind === 'tree').length,
    searchPartial: search?.partial ?? false,
    loading,
    empty: !loading && rows.length === 0,
  }
}
