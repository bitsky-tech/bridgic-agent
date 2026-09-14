/**
 * Per-session mounted local paths — "session outputs · session files" state.
 *
 * A mount is a REFERENCE to a real local path (picked via the native
 * dialog) registered on the daemon (`/sessions/{id}/mounts`); the agent
 * operates on it in place. State here is a plain per-session cache of
 * the daemon's registry — the daemon is the source of truth, every
 * mutation round-trips through it (no optimistic insert: the daemon
 * mints the mount id that the `@` mention later carries).
 *
 * Keyed by daemon session id. Draft sessions never have mounts (they
 * don't exist on the daemon yet) — callers materialize the draft first
 * (see agent.ts materializeToDaemon) before mounting.
 */
import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import type { DirListResult } from '@shared/dir-tree'
import { graftTree } from '@/lib/fileTree'
import type { MountSummary } from '@/lib/amphiClient'
import type { PasteItem } from '@/components/composer/pasteClassify'
import { buildAmphiClient } from './backend'
import { draftSessionIdsAtom } from './sessions'
import {
  SessionWorkbenchSurface,
  notifySessionWorkbenchActivityAtom,
} from './workbench'
import { rlog } from '@/lib/logger'

/** Primitive: sessionId → that session's mounts. Not exported (§1.13). */
const _mounts = atom<Record<string, MountSummary[]>>({})

/** Read: one session's mounts (empty until `loadMountsAtom` ran). */
export const mountsFamily = atomFamily((sessionId: string) =>
  atom((get) => get(_mounts)[sessionId] ?? []),
)

/** Action: refresh one session's mounts from the daemon (GET). Drafts are
 *  skipped (they don't exist on the daemon yet — a GET would just 404). */
export const loadMountsAtom = atom(null, async (get, set, sessionId: string) => {
  if (get(draftSessionIdsAtom).has(sessionId)) return
  const client = buildAmphiClient(get)
  if (!client) return
  try {
    const mounts = await client.listMounts(sessionId)
    set(_mounts, { ...get(_mounts), [sessionId]: mounts })
  } catch (err) {
    rlog.warn('[mounts] listMounts failed', { sessionId, err })
  }
})

// ─── Per-mount lazy directory snapshots ─────────────────────────────────────
//
// SNAPSHOT semantics, not cache semantics (explicit user requirement): only
// the mount root lives in the daemon's DB; directory content is re-read from
// disk per level, on demand — expanding the root re-reads its level, and
// every deeper expand reads exactly that level (`fs.listDir`) and grafts it
// in. No depth/size caps anywhere in browse; out-of-band deletes show up on
// the next expand. SEARCH never touches these snapshots — it walks in the
// main process per query (`fs.searchDir`).

/** Primitive: mountId → progressively-grafted snapshot. Not exported (§1.13). */
const _mountTrees = atom<Record<string, DirListResult>>({})

/** Read: one mount's latest snapshot (undefined until first root load). */
export const mountTreeFamily = atomFamily((mountId: string) =>
  atom((get): DirListResult | undefined => get(_mountTrees)[mountId]),
)

/** Read: the whole mountId→snapshot map — the @ popover's browse mode
 *  renders ALL folder mounts at once (per-id family reads don't compose
 *  over a dynamic mount list inside one hook). */
export const mountTreesAtom = atom((get) => get(_mountTrees))

/** Action: (re)read a mount's ROOT level fresh from disk — called on every
 *  expand/popover-open, resetting any previously grafted deeper levels (they
 *  re-load on demand as the user drills in). A `not-found` also refreshes
 *  the mount list so the row's `exists` flag catches up with reality. */
export const loadMountRootAtom = atom(
  null,
  async (get, set, payload: { sessionId: string; mountId: string; path: string }) => {
    const { sessionId, mountId, path } = payload
    const key = `${mountId}:`
    if (get(_pendingLevelLoads).has(key)) return // right panel + popover fire together → read once
    set(_pendingLevelLoads, new Set([...get(_pendingLevelLoads), key]))
    try {
      const result = await window.api.fs.listDir(path)
      // Read the map AFTER the await so parallel loads merge, not clobber.
      set(_mountTrees, { ...get(_mountTrees), [mountId]: result })
      if (!result.ok) {
        rlog.warn('[mounts] listDir(root) failed', { mountId, path, reason: result.reason })
        if (result.reason === 'not-found') void set(loadMountsAtom, sessionId)
      }
    } finally {
      const next = new Set(get(_pendingLevelLoads))
      next.delete(key)
      set(_pendingLevelLoads, next)
    }
  },
)

/** In-flight level reads (`${mountId}:${relPath}`) — the declarative
 *  reconcilers in MountRow / useMentionMenuState fire loads whenever an
 *  expanded node lacks content, so dedupe is what prevents read storms. */
const _pendingLevelLoads = atom<ReadonlySet<string>>(new Set<string>())

// ─── Watched levels (fs-watch contributions) ────────────────────────────────
//
// Live disk→tree sync: each MountRow CONTRIBUTES the directory levels it has
// expanded; `useFsWatchBridge` unions them and pushes the set to main, which
// watches each non-recursively and pushes `fsChanged` back per change. Keyed
// by mountId so a row owns exactly its own contribution (overwrite on expand/
// collapse, withdraw on unmount).

/** One expanded directory level to watch. `relPath === ''` = the mount root;
 *  `absPath` is the watch key + the reverse-lookup key for an incoming
 *  `fsChanged`; `mountPath`/`relPath` feed the existing level re-readers. */
export interface WatchedLevel {
  mountId: string
  mountPath: string
  relPath: string
  absPath: string
}

/** Primitive: mountId → its expanded levels. Not exported (§1.13). */
const _watchedLevels = atom<Record<string, WatchedLevel[]>>({})

/** Read: the flattened union of every mount's watched levels — the bridge's
 *  single source for "what to watch" + "how to map a change back". */
export const watchedLevelsAtom = atom((get) => Object.values(get(_watchedLevels)).flat())

/** Action: a MountRow declares its current expanded levels (overwrite), or
 *  withdraws them on unmount (`levels: []` drops the key entirely). */
export const contributeWatchedLevelsAtom = atom(
  null,
  (get, set, payload: { mountId: string; levels: WatchedLevel[] }) => {
    const cur = get(_watchedLevels)
    if (payload.levels.length === 0) {
      if (!(payload.mountId in cur)) return
      const { [payload.mountId]: _drop, ...rest } = cur
      set(_watchedLevels, rest)
      return
    }
    set(_watchedLevels, { ...cur, [payload.mountId]: payload.levels })
  },
)

/** Action: read ONE level (`relPath` inside the mount, fresh from disk) and
 *  graft it into the snapshot. Called on EVERY expand (freshness: an expand
 *  always reads live, never reusing last time's content) and by the
 *  reconcilers (self-healing when an expanded node lost its content to an
 *  out-of-band snapshot reset). Load failure marks the node `unreadable`
 *  instead of leaving a forever-spinner. */
export const loadMountLevelAtom = atom(
  null,
  async (
    get,
    set,
    payload: { mountId: string; mountPath: string; relPath: string },
  ): Promise<void> => {
    const { mountId, mountPath, relPath } = payload
    const key = `${mountId}:${relPath}`
    if (get(_pendingLevelLoads).has(key)) return
    set(_pendingLevelLoads, new Set([...get(_pendingLevelLoads), key]))
    try {
      // A POSIX join is the real path on macOS/Linux; on Windows Node accepts mixed separators.
      const result = await window.api.fs.listDir(`${mountPath}/${relPath}`, relPath)
      const current = get(_mountTrees)[mountId]
      if (!current?.ok) return // the root snapshot was replaced/invalidated — this graft is void.
      const update = result.ok
        ? { children: result.nodes }
        : ({ unreadable: true } as const)
      if (!result.ok) {
        rlog.warn('[mounts] listDir(level) failed', { mountId, relPath, reason: result.reason })
      }
      set(_mountTrees, {
        ...get(_mountTrees),
        [mountId]: { ok: true, nodes: graftTree(current.nodes, relPath, update) },
      })
    } finally {
      const next = new Set(get(_pendingLevelLoads))
      next.delete(key)
      set(_pendingLevelLoads, next)
    }
  },
)

/** Merge daemon-created mounts into the per-Session cache without duplicates. */
const mergeMountsAtom = atom(
  null,
  (get, set, payload: { sessionId: string; mounts: MountSummary[] }) => {
    const current = get(_mounts)[payload.sessionId] ?? []
    const merged = [...payload.mounts, ...current]
    const deduped = merged.filter((mount, index) =>
      merged.findIndex((candidate) => candidate.id === mount.id) === index)
    set(_mounts, { ...get(_mounts), [payload.sessionId]: deduped })
  },
)

/** Notify the dock about a successful manual attachment at completion time. */
const notifySessionFilesAtom = atom(
  null,
  (
    _get,
    set,
    payload: { agentModeHasPriority: boolean; sessionId: string },
  ) => {
    set(notifySessionWorkbenchActivityAtom, {
      ...payload,
      surface: SessionWorkbenchSurface.Files,
    })
  },
)

/** Action: mount local absolute paths onto a session (native-dialog picks or
 *  pasted content). One POST per path; partial failure keeps the successes (a
 *  bad path — vanished between pick and POST, or a pasted pseudo-path that
 *  doesn't exist on the daemon host — must not void the others). Returns the
 *  rows actually mounted (callers read `.length`, or use the ids/labels to
 *  insert @-mentions). */
export const addMountsAtom = atom(
  null,
  async (get, set, payload: { sessionId: string; paths: string[] }): Promise<MountSummary[]> => {
    const { sessionId, paths } = payload
    const client = buildAmphiClient(get)
    if (!client || paths.length === 0) return []
    const added: MountSummary[] = []
    for (const path of paths) {
      try {
        added.push(await client.addMount(sessionId, path))
      } catch (err) {
        rlog.warn('[mounts] addMount failed', { sessionId, path, err })
      }
    }
    if (added.length === 0) return []
    set(mergeMountsAtom, { sessionId, mounts: added })
    return added
  },
)

/** Action: full "add" flow — native dialog pick → mount onto the session.
 *
 *  `kind` decides the dialog mode: Win/Linux cannot mix `openFile` and
 *  `openDirectory` in ONE dialog (Electron constraint), so the caller's small
 *  menu makes the user choose first — identical behavior on all platforms.
 *  A draft session is materialized to the daemon first (the mount registry
 *  is keyed by daemon session id); the caller's `sessionId` may therefore be
 *  superseded — we mount onto the returned daemon id. Returns the daemon id
 *  actually mounted onto (null = cancelled or failed). */
export const pickAndMountAtom = atom(
  null,
  async (
    get,
    set,
    payload: { sessionId: string; kind: 'file' | 'folder' },
  ): Promise<string | null> => {
    const result = await window.api.dialog.open({
      properties:
        payload.kind === 'folder'
          ? ['openDirectory', 'multiSelections']
          : ['openFile', 'multiSelections'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // Dynamic import breaks the mounts.ts ↔ agent.ts static cycle (agent.ts
    // doesn't import mounts, but this keeps the same defensive pattern as
    // sessions.ts + stays bun:test friendly).
    const agent = await import('./agent')
    const sid = await set(agent.ensureDaemonSessionAtom, payload.sessionId)
    if (!sid) {
      rlog.warn('[mounts] pickAndMount aborted — no daemon session', payload)
      return null
    }
    const added = await set(addMountsAtom, { sessionId: sid, paths: result.filePaths })
    // Mount succeeded → notify Files. The dock reveals it only when empty;
    // otherwise its rail entry flashes without replacing the current surface.
    if (added.length === 0) return null
    const position = get(agent.thinkingModeFamily(sid))
    set(notifySessionFilesAtom, {
      agentModeHasPriority: position?.mode === 'build'
        || position?.mode === 'presentation'
        || position?.mode === 'run_workflow',
      sessionId: sid,
    })
    return sid
  },
)

/** A queued "insert @-mention into the composer" command — produced by the
 *  right-panel mount menu's "add to chat" and by the paste→mount flow, consumed
 *  (and cleared) by FreeFormInput. A one-shot command CHANNEL, NOT derived
 *  state: the editor owns its Segment[] locally, so external inserts must
 *  arrive as events. A queue (not a single slot) so one paste of several files
 *  enqueues several mentions without clobbering each other. */
export interface MentionInsert {
  /** Daemon mount id → becomes the mention's data-token-id. */
  id: string
  /** Display label (folder names carry a trailing `/`). */
  label: string
  /** Structured mention kind; defaults to a Session file reference. */
  group?: string
  /** Mount-relative POSIX path when referencing a file/folder INSIDE a
   *  mounted folder (right-panel tree rows); absent = the mount root. */
  path?: string
}

const _pendingMentionInserts = atom<MentionInsert[]>([])

/** Read: the queued inserts (empty when none). Composer-side consumer only. */
export const pendingMentionInsertsAtom = atom((get) => get(_pendingMentionInserts))

/** Action: enqueue an @-mention append into the composer (right panel's "add to
 *  chat" / paste→mount). Appended so multiple requests in one tick all survive. */
export const requestMentionInsertAtom = atom(null, (get, set, m: MentionInsert) => {
  set(_pendingMentionInserts, [...get(_pendingMentionInserts), m])
})

/** Action: composer drained the queue — clear it. */
export const consumeMentionInsertsAtom = atom(null, (_get, set) => {
  set(_pendingMentionInserts, [])
})

/** Action: unmount; uploaded attachments are deleted, external sources remain. */
export const removeMountAtom = atom(
  null,
  async (get, set, payload: { sessionId: string; mountId: string }) => {
    const { sessionId, mountId } = payload
    const client = buildAmphiClient(get)
    if (!client) return
    try {
      await client.removeMount(sessionId, mountId)
      const current = get(_mounts)[sessionId] ?? []
      set(_mounts, {
        ...get(_mounts),
        [sessionId]: current.filter((m) => m.id !== mountId),
      })
    } catch (err) {
      rlog.warn('[mounts] removeMount failed', { sessionId, mountId, err })
    }
  },
)

/** Action: turn a clipboard paste into one or more session-file mounts.
 *
 *  A draft Session is materialized first. `path` items mount an existing local
 *  path; `file` / `text` items use the Session upload endpoint, which writes
 *  and registers the mount atomically. On success the right panel switches to
 *  session files and an @-mention is enqueued for each mount, in paste order.
 *
 *  Returns the text to restore into the editor when a SINGLE text-bearing paste
 *  (a pseudo-path or large text) could NOT be mounted — so the user's content
 *  is never silently lost after the paste was preventDefault'd; null otherwise. */
export const pasteToSessionFilesAtom = atom(
  null,
  async (
    get,
    set,
    payload: { sessionId: string; items: PasteItem[] },
  ): Promise<string | null> => {
    const { sessionId, items } = payload
    // Text to fall back into the editor if a lone text/path item fails to mount.
    const singleItem = items.length === 1 ? items[0] : null
    let fallback: string | null = null
    if (singleItem?.kind === 'path') fallback = singleItem.path
    else if (singleItem?.kind === 'text') fallback = singleItem.text
    const client = buildAmphiClient(get)
    if (!client || items.length === 0) return fallback

    // 1. Materialize the draft before writing any managed attachment.
    const agent = await import('./agent')
    const sid = await set(agent.ensureDaemonSessionAtom, sessionId)
    if (!sid) {
      rlog.warn('[mounts] pasteToSessionFiles aborted — no daemon session', { sessionId })
      return fallback
    }

    // 2. Create one mount per input item, preserving paste order.
    const ts = Date.now()
    const added: MountSummary[] = []
    for (const [index, item] of items.entries()) {
      try {
        if (item.kind === 'path') {
          added.push(await client.addMount(sid, item.path))
        } else if (item.kind === 'file') {
          added.push(await client.uploadMount(
            sid,
            item.file.name || `${ts}-${index}-attachment.bin`,
            item.file,
          ))
        } else {
          const blob = new Blob([item.text], { type: 'text/plain' })
          added.push(await client.uploadMount(sid, `${ts}-${index}-snippet.txt`, blob))
        }
      } catch (err) {
        rlog.warn('[mounts] paste mount failed', { kind: item.kind, err })
      }
    }
    if (added.length === 0) return fallback
    set(mergeMountsAtom, { sessionId: sid, mounts: added })

    // 3. Notify the Files dock + enqueue an @-mention per mount.
    const position = get(agent.thinkingModeFamily(sid))
    set(notifySessionFilesAtom, {
      agentModeHasPriority: position?.mode === 'build'
        || position?.mode === 'presentation'
        || position?.mode === 'run_workflow',
      sessionId: sid,
    })
    for (const m of added) {
      set(requestMentionInsertAtom, {
        id: m.id,
        label: m.kind === 'folder' ? `${m.name}/` : m.name,
      })
    }
    return null
  },
)
