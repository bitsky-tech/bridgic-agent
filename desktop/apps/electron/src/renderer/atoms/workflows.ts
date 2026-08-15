import { atom } from 'jotai'
import type {
  WorkflowDetail,
  WorkflowRunDetail,
  WorkflowRunFileContent,
  WorkflowRunSummary,
  WorkflowSummary,
} from '@/lib/amphiClient'
import { rlog } from '@/lib/logger'
import { i18n } from '@/lib/i18n'
import type { ChatBlock } from '@shared/types'
import { prepareInteractionContinuationAtom, updateWorkflowConfirmBlockAtom } from './agent'
import { buildAmphiClient } from './backend'
import { requestConfirmAtom } from './confirm'
import {
  activeSessionIdAtom,
  draftSessionIdsAtom,
  markSessionAnsweredAtom,
  sessionsMetaAtom,
} from './sessions'
import { showToastAtom } from './toast'

const _workflows = atom<WorkflowSummary[]>([])
const _sessionWorkflows = atom<Record<string, WorkflowSummary[]>>({})
const _sessionWorkflowRuns = atom<Record<string, WorkflowRunSummary[]>>({})
const _workflowDetails = atom<Record<string, WorkflowDetail>>({})
const _workflowRuns = atom<WorkflowRunSummary[]>([])
const _workflowRunDetails = atom<Record<string, WorkflowRunDetail>>({})
const _workflowRunFiles = atom<Record<string, WorkflowRunFileContent>>({})

export const workflowsAtom = atom((get) => get(_workflows))
export const workflowDetailsAtom = atom((get) => get(_workflowDetails))
export const workflowRunsAtom = atom((get) => get(_workflowRuns))
export const workflowRunDetailsAtom = atom((get) => get(_workflowRunDetails))
export const workflowRunFilesAtom = atom((get) => get(_workflowRunFiles))

/** Daemon-side clamp on `GET /workflow-runs?limit=` (`min(limit, 200)`).
 *  Asking for more per page would silently get 200 back and mis-detect the
 *  last page, so pagers must request exactly this. */
const RUN_PAGE_SIZE = 200

/**
 * Read the whole Run index for one filter by walking `offset` to exhaustion.
 *
 * Why every caller must page: the daemon's default is `limit=100`, so a bare
 * `listWorkflowRuns()` silently caps at 100 rows with no marker in the payload
 * — the list just looks complete. That cap was user-visible, not merely
 * theoretical: `useMentionMenuState` derives the "N more" counter and the
 * scope-link total from `matchedWorkflowRuns.length`, so a truncated array
 * under-reported the total AND made the "more" pager unable to reach anything
 * past row 100.
 *
 * Stops on a short page, and also on a page that adds nothing new (defensive
 * against an unstable `created_at` ordering shifting rows across page
 * boundaries, which would otherwise loop forever).
 *
 * Cost: a menu open now issues ceil(total / 200) requests instead of one. That
 * is deliberate for now — correct counts beat one round-trip. The real fix is
 * a `total` in the response envelope so the menu can show the true count off
 * page one and fetch further pages only when the user asks; do that when
 * `GET /workflow-runs` moves to the paginated envelope.
 */
async function fetchAllWorkflowRuns(
  client: NonNullable<ReturnType<typeof buildAmphiClient>>,
  sessionId?: string,
): Promise<WorkflowRunSummary[]> {
  const runs: WorkflowRunSummary[] = []
  const seen = new Set<string>()
  for (let offset = 0; ; offset += RUN_PAGE_SIZE) {
    const page = await client.listWorkflowRuns(undefined, undefined, {
      limit: RUN_PAGE_SIZE,
      offset,
      sessionId,
    })
    let added = 0
    for (const run of page) {
      if (seen.has(run.id)) continue
      seen.add(run.id)
      runs.push(run)
      added += 1
    }
    if (page.length < RUN_PAGE_SIZE || added === 0) return runs
  }
}

function mergeWorkflowRuns(
  incoming: WorkflowRunSummary[],
  current: WorkflowRunSummary[],
): WorkflowRunSummary[] {
  const rows = new Map(current.map((run) => [run.id, run]))
  for (const run of incoming) rows.set(run.id, run)
  return [...rows.values()].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  )
}

export const activeSessionWorkflowsAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  if (!sessionId) return []
  return get(_sessionWorkflows)[sessionId] ?? []
})

export const activeSessionWorkflowRunsAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  if (!sessionId) return []
  return get(_sessionWorkflowRuns)[sessionId] ?? []
})

/** Load only saved Workflow definitions for the standalone Workflow workbench. */
export const hydrateWorkflowDefinitionsAtom = atom(null, async (get, set) => {
  const client = buildAmphiClient(get)
  if (!client) return []
  try {
    const workflows = await client.listWorkflows()
    set(_workflows, workflows)
    return workflows
  } catch (err: unknown) {
    rlog.warn('[workflows] definitions hydrate failed', { err })
    return []
  }
})

export const hydrateWorkflowsAtom = atom(null, async (get, set) => {
  await set(hydrateWorkflowDefinitionsAtom)
  const client = buildAmphiClient(get)
  if (!client) return
  try {
    set(
      _workflowRuns,
      mergeWorkflowRuns(await fetchAllWorkflowRuns(client), get(_workflowRuns)),
    )
  } catch (err: unknown) {
    rlog.warn('[workflows] runs hydrate failed', { err })
  }
})

export const hydrateSessionWorkflowsAtom = atom(null, async (get, set, sessionId: string) => {
  // Draft sessions live only in the renderer: `newSessionAtom` mints an
  // `s-<uuid>` locally and the daemon only learns about a session when the
  // first message is sent (its ids look like `session_20260728_181518_…`).
  // Asking the daemon for a draft's workflows is therefore a guaranteed 404 —
  // `Session 's-…' is not registered`. Harmless (a draft has no workflows) but
  // it fired on every switch to a draft and filled main.log with warnings.
  //
  // Guarded here rather than at the call site so every future caller inherits
  // it; BuildProgressPanel's effect only knows "there is a session id".
  if (get(draftSessionIdsAtom).has(sessionId)) return
  const client = buildAmphiClient(get)
  if (!client) return
  try {
    const workflows = await client.listWorkflows(sessionId)
    const current = get(_sessionWorkflows)[sessionId] ?? []
    const loaded = new Set(workflows.map((workflow) => workflow.id))
    set(_sessionWorkflows, {
      ...get(_sessionWorkflows),
      [sessionId]: [
        ...workflows,
        ...current.filter((workflow) => !loaded.has(workflow.id)),
      ],
    })
  } catch (err: unknown) {
    rlog.warn('[workflows] session definitions hydrate failed', { sessionId, err })
  }
})

/** Load the published Workflow results associated with one Session for its output panel. */
export const hydrateSessionWorkflowRunsAtom = atom(null, async (get, set, sessionId: string) => {
  if (get(draftSessionIdsAtom).has(sessionId)) return []
  const client = buildAmphiClient(get)
  if (!client) return []
  try {
    const runs = await fetchAllWorkflowRuns(client, sessionId)
    const current = get(_sessionWorkflowRuns)[sessionId] ?? []
    const loaded = new Set(runs.map((run) => run.id))
    set(_sessionWorkflowRuns, {
      ...get(_sessionWorkflowRuns),
      [sessionId]: [
        ...runs,
        ...current.filter((run) => !loaded.has(run.id)),
      ],
    })
    set(_workflowRuns, mergeWorkflowRuns(runs, get(_workflowRuns)))
    return runs
  } catch (err: unknown) {
    rlog.warn('[workflows] session runs hydrate failed', { sessionId, err })
    return []
  }
})

/**
 * Strict variant used by the standalone Run Records workbench.
 *
 * The legacy mixed output panel intentionally swallows transport failures so it
 * can degrade quietly. A dedicated tool needs to distinguish "empty" from
 * "could not load", so this variant updates the same caches but propagates the
 * request error to its caller.
 */
export const hydrateSessionWorkflowRunsStrictAtom = atom(
  null,
  async (get, set, sessionId: string) => {
    if (get(draftSessionIdsAtom).has(sessionId)) return []
    const client = buildAmphiClient(get)
    if (!client) return []
    const runs = await fetchAllWorkflowRuns(client, sessionId)
    const current = get(_sessionWorkflowRuns)[sessionId] ?? []
    const loaded = new Set(runs.map((run) => run.id))
    set(_sessionWorkflowRuns, {
      ...get(_sessionWorkflowRuns),
      [sessionId]: [
        ...runs,
        ...current.filter((run) => !loaded.has(run.id)),
      ],
    })
    set(_workflowRuns, mergeWorkflowRuns(runs, get(_workflowRuns)))
    return runs
  },
)

export const associateSessionWorkflowsFromInputAtom = atom(
  null,
  (get, set, payload: { sessionId: string; blocks: ChatBlock[] }) => {
    const session = get(sessionsMetaAtom).find((item) => item.id === payload.sessionId)
    const resourceSessionId = session?.parentSessionId ?? payload.sessionId
    const workflowIds = new Set<string>()
    const runIds = new Set<string>()
    for (const block of payload.blocks) {
      if (block.type === 'slash' && block.resource === 'workflow') {
        workflowIds.add(block.id)
      } else if (block.type === 'mention' && block.group === 'WorkflowRun') {
        const run = get(_workflowRuns).find((row) => row.id === block.id)
        if (run) {
          runIds.add(run.id)
          workflowIds.add(run.workflow_id)
        }
      } else if (
        block.type === 'mention'
        && ['Workflow', 'Workflows', 'WorkflowEntity'].includes(block.group)
      ) {
        workflowIds.add(block.id)
      }
    }
    const associated = get(_workflows).filter((workflow) => workflowIds.has(workflow.id))
    if (associated.length > 0) {
      const current = get(_sessionWorkflows)[resourceSessionId] ?? []
      const added = new Set(associated.map((workflow) => workflow.id))
      set(_sessionWorkflows, {
        ...get(_sessionWorkflows),
        [resourceSessionId]: [
          ...associated,
          ...current.filter((workflow) => !added.has(workflow.id)),
        ],
      })
    }

    const associatedRuns = get(_workflowRuns).filter((run) => runIds.has(run.id))
    if (associatedRuns.length > 0) {
      const current = get(_sessionWorkflowRuns)[resourceSessionId] ?? []
      const added = new Set(associatedRuns.map((run) => run.id))
      set(_sessionWorkflowRuns, {
        ...get(_sessionWorkflowRuns),
        [resourceSessionId]: [
          ...associatedRuns,
          ...current.filter((run) => !added.has(run.id)),
        ],
      })
    }
  },
)

/** Move optimistic resource projections when a draft receives its daemon id. */
export const remapSessionWorkflowResourcesAtom = atom(
  null,
  (get, set, payload: { sourceSessionId: string; targetSessionId: string }) => {
    const move = <T extends { id: string }>(rows: Record<string, T[]>): Record<string, T[]> => {
      const source = rows[payload.sourceSessionId]
      if (!source) return rows
      const target = rows[payload.targetSessionId] ?? []
      const sourceIds = new Set(source.map((item) => item.id))
      const next = { ...rows }
      next[payload.targetSessionId] = [
        ...source,
        ...target.filter((item) => !sourceIds.has(item.id)),
      ]
      delete next[payload.sourceSessionId]
      return next
    }

    set(_sessionWorkflows, move(get(_sessionWorkflows)))
    set(_sessionWorkflowRuns, move(get(_sessionWorkflowRuns)))
  },
)

export const hydrateWorkflowRunsAtom = atom(
  null,
  async (get, set, payload?: { workflowId?: string; query?: string }) => {
    const client = buildAmphiClient(get)
    if (!client) return []
    try {
      const runs = await client.listWorkflowRuns(payload?.workflowId, payload?.query)
      if (!payload?.query) {
        set(_workflowRuns, mergeWorkflowRuns(runs, get(_workflowRuns)))
      }
      return runs
    } catch (err: unknown) {
      rlog.warn('[workflows] runs hydrate failed', { payload, err })
      throw err
    }
  },
)

/** Load the complete durable Run index in bounded pages for the asset browser. */
export const hydrateAllWorkflowRunsAtom = atom(null, async (get, set) => {
  const client = buildAmphiClient(get)
  if (!client) return []
  try {
    const runs = await fetchAllWorkflowRuns(client)
    set(_workflowRuns, runs)
    return runs
  } catch (err: unknown) {
    rlog.warn('[workflows] complete run index hydrate failed', { err })
    throw err
  }
})

export const hydrateWorkflowRunDetailAtom = atom(
  null,
  async (get, set, payload: { runId: string }) => {
    const client = buildAmphiClient(get)
    if (!client) return
    try {
      const detail = await client.getWorkflowRun(payload.runId)
      set(_workflowRunDetails, { ...get(_workflowRunDetails), [detail.id]: detail })
      return detail
    } catch (err: unknown) {
      rlog.warn('[workflows] run detail hydrate failed', { runId: payload.runId, err })
      throw err
    }
  },
)

export const hydrateWorkflowRunFileAtom = atom(
  null,
  async (get, set, payload: { runId: string; path: string }) => {
    const client = buildAmphiClient(get)
    if (!client) return
    const key = `${payload.runId}:${payload.path}`
    try {
      const file = await client.getWorkflowRunFile(payload.runId, payload.path)
      set(_workflowRunFiles, { ...get(_workflowRunFiles), [key]: file })
      return file
    } catch (err: unknown) {
      rlog.warn('[workflows] run file hydrate failed', { ...payload, err })
      throw err
    }
  },
)

export const loadWorkflowRunRawFileAtom = atom(
  null,
  async (get, _set, payload: { runId: string; path: string }) => {
    const client = buildAmphiClient(get)
    if (!client) throw new Error(i18n.t('error.gatewayNotReady'))
    return client.getWorkflowRunFileRaw(payload.runId, payload.path)
  },
)

export const checkWorkflowAvailabilityAtom = atom(
  null,
  async (get, _set, workflowId: string) => {
    const client = buildAmphiClient(get)
    if (!client) throw new Error(i18n.t('error.gatewayNotReady'))
    return client.getWorkflowAvailability(workflowId)
  },
)

export const hydrateWorkflowDetailAtom = atom(
  null,
  async (get, set, payload: { workflowId: string }) => {
    const client = buildAmphiClient(get)
    if (!client) return
    try {
      const detail = await client.getWorkflow(payload.workflowId)
      set(_workflowDetails, { ...get(_workflowDetails), [detail.id]: detail })
      return detail
    } catch (err: unknown) {
      rlog.warn('[workflows] detail hydrate failed', { workflowId: payload.workflowId, err })
      throw err
    }
  },
)

export const importWorkflowAtom = atom(null, async (get, set, file: File) => {
  const client = buildAmphiClient(get)
  if (!client) {
    set(showToastAtom, i18n.t('error.gatewayNotReady'))
    return
  }
  try {
    const workflow = await client.importWorkflow(file)
    set(_workflows, [workflow, ...get(_workflows).filter((row) => row.id !== workflow.id)])
    set(showToastAtom, i18n.t('toast.workflowImported', { name: workflow.name }))
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : i18n.t('error.workflowImportFailed')
    set(showToastAtom, message)
    rlog.warn('[workflows] import failed', { err })
  }
})

function exportBaseName(name: string, fallback: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || fallback
}

export const exportWorkflowAtom = atom(
  null,
  async (get, set, payload: { workflowId: string; name: string }) => {
    const client = buildAmphiClient(get)
    if (!client) {
      set(showToastAtom, i18n.t('error.gatewayNotReady'))
      return
    }
    const baseName = exportBaseName(payload.name, payload.workflowId)
    const destination = await window.api.dialog.save({
      title: i18n.t('common.exportWorkflow'),
      defaultPath: `${baseName}.amphi-workflow`,
      filters: [{ name: 'Amphi Workflow', extensions: ['amphi-workflow'] }],
    })
    if (destination.canceled || !destination.filePath) return
    try {
      const content = await client.exportWorkflow(payload.workflowId)
      const outputPath = destination.filePath.toLowerCase().endsWith('.amphi-workflow')
        ? destination.filePath
        : `${destination.filePath}.amphi-workflow`
      await window.api.fs.writeWorkflowArchive(outputPath, content)
      set(showToastAtom, i18n.t('toast.workflowExported', { name: payload.name }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      set(showToastAtom, i18n.t('error.workflowExportFailed', { msg }))
      rlog.warn('[workflows] export failed', { ...payload, err })
    }
  },
)

export const exportWorkflowRunAtom = atom(
  null,
  async (
    get,
    set,
    payload: { runId: string; workflowName: string },
  ): Promise<boolean> => {
    const client = buildAmphiClient(get)
    if (!client) {
      set(showToastAtom, i18n.t('error.gatewayNotReady'))
      return false
    }
    try {
      const baseName = exportBaseName(payload.workflowName, payload.runId)
      const shortRunId = payload.runId.slice(0, 8)
      const destination = await window.api.dialog.save({
        title: i18n.t('workflow.runDetail.exportResult'),
        defaultPath: `${baseName}-${shortRunId}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (destination.canceled || !destination.filePath) return false
      const content = await client.exportWorkflowRun(payload.runId)
      const outputPath = destination.filePath.toLowerCase().endsWith('.zip')
        ? destination.filePath
        : `${destination.filePath}.zip`
      await window.api.fs.writeWorkflowRunArchive(outputPath, content)
      set(showToastAtom, i18n.t('toast.workflowRunExported', { name: payload.workflowName }))
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      set(showToastAtom, i18n.t('error.workflowRunExportFailed', { msg }))
      rlog.warn('[workflows] run export failed', { ...payload, err })
      return false
    }
  },
)

/** Rename one saved Workflow and refresh every current-definition projection. */
export const renameWorkflowAtom = atom(
  null,
  async (get, set, payload: { workflowId: string; name: string }): Promise<boolean> => {
    const client = buildAmphiClient(get)
    if (!client) {
      set(showToastAtom, i18n.t('error.gatewayNotReady'))
      return false
    }
    const name = payload.name.trim()
    if (!name) {
      set(showToastAtom, i18n.t('error.workflowNameRequired'))
      return false
    }
    try {
      const workflow = await client.renameWorkflow(payload.workflowId, name)
      const update = (row: WorkflowSummary): WorkflowSummary => (
        row.id === workflow.id ? { ...row, name: workflow.name } : row
      )
      set(_workflows, get(_workflows).map(update))
      set(
        _sessionWorkflows,
        Object.fromEntries(
          Object.entries(get(_sessionWorkflows)).map(([sessionId, workflows]) => [
            sessionId,
            workflows.map(update),
          ]),
        ),
      )
      const detail = get(_workflowDetails)[workflow.id]
      if (detail) {
        set(_workflowDetails, {
          ...get(_workflowDetails),
          [workflow.id]: { ...detail, name: workflow.name },
        })
      }
      set(showToastAtom, i18n.t('toast.workflowRenamed', { name: workflow.name }))
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      set(showToastAtom, i18n.t('error.workflowRenameFailed', { msg }))
      rlog.warn('[workflows] rename failed', { ...payload, err })
      return false
    }
  },
)

/** Delete one saved Workflow definition while retaining its durable Run results. */
export const deleteWorkflowAtom = atom(
  null,
  async (get, set, payload: { workflowId: string; name: string }): Promise<boolean> => {
    const client = buildAmphiClient(get)
    if (!client) {
      set(showToastAtom, i18n.t('error.gatewayNotReady'))
      return false
    }
    try {
      await client.deleteWorkflow(payload.workflowId)
      set(_workflows, get(_workflows).filter((row) => row.id !== payload.workflowId))
      set(
        _sessionWorkflows,
        Object.fromEntries(
          Object.entries(get(_sessionWorkflows)).map(([sessionId, workflows]) => [
            sessionId,
            workflows.filter((row) => row.id !== payload.workflowId),
          ]),
        ),
      )
      const details = { ...get(_workflowDetails) }
      delete details[payload.workflowId]
      set(_workflowDetails, details)
      set(showToastAtom, i18n.t('toast.workflowDeleted', { name: payload.name }))
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      set(showToastAtom, i18n.t('error.workflowDeleteFailed', { msg }))
      rlog.warn('[workflows] delete failed', { ...payload, err })
      return false
    }
  },
)

/** Permanently delete one terminal Workflow Run and its durable result files. */
export const deleteWorkflowRunAtom = atom(
  null,
  async (get, set, run: WorkflowRunSummary): Promise<boolean> => {
    const confirmed = await set(requestConfirmAtom, {
      title: i18n.t('common.deleteWorkflowRun'),
      message: i18n.t('common.deleteWorkflowRunMessage', { name: run.workflow_name }),
      confirmLabel: i18n.t('common.delete'),
      danger: true,
    })
    if (!confirmed) return false
    const client = buildAmphiClient(get)
    if (!client) {
      set(showToastAtom, i18n.t('error.gatewayNotReady'))
      return false
    }
    try {
      await client.deleteWorkflowRun(run.id)
      set(_workflowRuns, get(_workflowRuns).filter((row) => row.id !== run.id))
      set(
        _sessionWorkflowRuns,
        Object.fromEntries(
          Object.entries(get(_sessionWorkflowRuns)).map(([sessionId, runs]) => [
            sessionId,
            runs.filter((row) => row.id !== run.id),
          ]),
        ),
      )
      const details = { ...get(_workflowRunDetails) }
      delete details[run.id]
      set(_workflowRunDetails, details)
      set(
        _workflowRunFiles,
        Object.fromEntries(
          Object.entries(get(_workflowRunFiles)).filter(([key]) => !key.startsWith(`${run.id}:`)),
        ),
      )
      set(showToastAtom, i18n.t('toast.workflowRunDeleted'))
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      set(showToastAtom, i18n.t('error.workflowRunDeleteFailed', { msg }))
      rlog.warn('[workflows] run delete failed', { runId: run.id, err })
      return false
    }
  },
)

export const confirmWorkflowBuildAtom = atom(
  null,
  async (
    _get,
    set,
    payload: {
      sessionId: string
      requestId: string
      action: 'confirm' | 'save_as_new' | 'cancel'
      name?: string
    },
  ) => {
    const name = payload.name?.trim() || null
    if (payload.action !== 'cancel' && !name) {
      throw new Error(i18n.t('error.workflowNameRequired'))
    }

    const patch = (() => {
      if (payload.action === 'cancel') return { status: 'cancelled' as const }
      if (payload.action === 'save_as_new') {
        return {
          status: 'continued' as const,
          name,
          operation: 'create' as const,
          workflowId: null,
        }
      }
      return {
        status: 'continued' as const,
        name,
      }
    })()

    set(updateWorkflowConfirmBlockAtom, {
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      patch,
    })
    set(prepareInteractionContinuationAtom, { sessionId: payload.sessionId })
    set(markSessionAnsweredAtom, payload.sessionId)

    const connection = await import('@/lib/amphiWsConnection')
    connection.getAmphiWsConnection().workflowConfirm(payload.sessionId, {
      request_id: payload.requestId,
      action: payload.action,
      name,
    })
  },
)
