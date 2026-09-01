/**
 * Tests for atoms/sessions.ts lifecycle + drafts.
 */
import { afterAll, describe, it, expect, mock, setSystemTime } from 'bun:test'
import { createStore } from 'jotai'

import { installSessionsApiStub } from './sessions-api-stub'

// Stub window.api.sessions.* for Phase B persistence side-effects. The atoms
// fire-and-forget IPC calls on each meta mutation; without a stub the
// `window` global is undefined under bun:test and the call throws.
const restoreSessionsApi = installSessionsApiStub({
  listMeta: mock(async () => []),
  loadMessages: mock(async () => []),
  appendMessage: mock(async () => {}),
  saveMeta: mock(async () => {}),
  deleteSession: mock(async () => {}),
})
afterAll(restoreSessionsApi)
import {
  activeIsDraftAtom,
  activeSessionIdAtom,
  bootPendingAtom,
  clearSessionDraftAtom,
  draftSessionIdsAtom,
  hydrateSessionsFromDaemonAtom,
  markBootLandedAtom,
  markSessionAnsweredAtom,
  markSessionReadAtom,
  markSessionUnreadAtom,
  materializeSessionAtom,
  setAllDraftsAtom,
  pruneDrafts,
  newSessionAtom,
  nextPersistedSessionId,
  pickInitialSession,
  removeSessionAtom,
  renameSessionAtom,
  selectSessionAtom,
  sessionDraftsAtom,
  sessionsMetaAtom,
  replaceDraftWithDaemonIdAtom,
  setSessionDraftAtom,
  submitSessionDraftAtom,
  SUBMIT_ECHO_WINDOW_MS,
  sidebarSessionsAtom,
  updateSessionTitleAtom,
  type SessionMeta,
} from '../sessions'
import { backendSnapshotAtom } from '../backend'
import { BackendState } from '../../../main/python-client/types'
import type { Segment } from '@/components/composer/segments'

function makeStore() {
  return createStore()
}

describe('pickInitialSession (boot-time restore target)', () => {
  const metas: SessionMeta[] = [
    { id: 'a', title: 'A', createdAt: 0, updatedAt: 0 },
    { id: 'b', title: 'B', createdAt: 0, updatedAt: 0 },
  ]

  it('restores only a remembered session that still exists', () => {
    expect(pickInitialSession(metas, 'b')).toBe('b')
    expect(pickInitialSession(metas, 'gone')).toBeNull()
    expect(pickInitialSession(metas, null)).toBeNull()
    expect(pickInitialSession([], 'a')).toBeNull()
  })
})

describe('nextPersistedSessionId (boot-time restore source — "reopen = exact last view")', () => {
  const drafts = new Set(['draft-1'])

  it('persists drafts, real sessions, and boot transients correctly', () => {
    // The reported bug: 点新会话后刷新跳回旧会话。Locking: a draft active id must
    // overwrite the remembered real id with null.
    expect(nextPersistedSessionId('draft-1', drafts, 'session_real')).toBeNull()
    expect(nextPersistedSessionId('session_real', drafts, null)).toBe('session_real')
    // Must NOT clobber the id useSessionBootstrap is about to read.
    expect(nextPersistedSessionId(null, drafts, 'session_real')).toBe('session_real')
    expect(nextPersistedSessionId(null, drafts, null)).toBeNull()
    expect(nextPersistedSessionId('session_real', drafts, 'session_real')).toBe('session_real')
  })
})

describe('bootPendingAtom (闪 Landing 防抖占位)', () => {
  function setBackendState(store: ReturnType<typeof makeStore>, state: BackendState) {
    store.set(backendSnapshotAtom, { state, endpoint: null, lastError: null, compatibility: null })
  }

  it('stays pending only until bootstrap lands or the daemon is unavailable', () => {
    const store = makeStore()
    expect(store.get(bootPendingAtom)).toBe(true)
    store.set(markBootLandedAtom)
    expect(store.get(bootPendingAtom)).toBe(false)
    setBackendState(store, BackendState.Discovering)
    expect(store.get(bootPendingAtom)).toBe(false)

    const unavailableStore = makeStore()
    setBackendState(unavailableStore, BackendState.Unavailable)
    expect(unavailableStore.get(bootPendingAtom)).toBe(false)
  })
})

describe('newSessionAtom', () => {
  it('creates a draft session not visible in sidebar', () => {
    const store = makeStore()
    const id = store.set(newSessionAtom)
    expect(store.get(sessionsMetaAtom)).toHaveLength(1)
    expect(store.get(draftSessionIdsAtom).has(id)).toBe(true)
    expect(store.get(sidebarSessionsAtom)).toHaveLength(0)
    expect(store.get(activeSessionIdAtom)).toBe(id)
  })
})

describe('materializeSessionAtom', () => {
  it('removes session from draft set so it appears in sidebar', () => {
    const store = makeStore()
    const id = store.set(newSessionAtom)
    store.set(materializeSessionAtom, id)
    expect(store.get(draftSessionIdsAtom).has(id)).toBe(false)
    expect(store.get(sidebarSessionsAtom)).toHaveLength(1)
  })
})

describe('removeSessionAtom', () => {
  it('cleans up meta / drafts / draftIds / activeId', () => {
    const store = makeStore()
    const id = store.set(newSessionAtom)
    store.set(setSessionDraftAtom, { id, segments: [{ type: 'text', value: 'draft' }] })
    store.set(removeSessionAtom, id)
    expect(store.get(sessionsMetaAtom)).toHaveLength(0)
    expect(store.get(sessionDraftsAtom)[id]).toBeUndefined()
    expect(store.get(draftSessionIdsAtom).has(id)).toBe(false)
    expect(store.get(activeSessionIdAtom)).toBeNull()
  })
})

describe('setSessionDraftAtom', () => {
  it('stores per-session draft segments (preserving @ mention chips)', () => {
    const store = makeStore()
    // 两个任意 session id —— 本 atom 只写 drafts map,不校验 session 是否存在。
    // (不用两次 newSession 造:未实化会话是单例,两次拿到的是同一个 id。)
    const a = 'session_a'
    const b = store.set(newSessionAtom)
    const aSegs: Segment[] = [
      { type: 'text', value: '看 ' },
      { type: 'mention', id: 'mnt_x', label: 'doc.md', group: '文件/文件夹', path: 'sub/doc.md' },
    ]
    store.set(setSessionDraftAtom, { id: a, segments: aSegs })
    store.set(setSessionDraftAtom, { id: b, segments: [{ type: 'text', value: 'B draft' }] })
    expect(store.get(sessionDraftsAtom)[a]).toEqual(aSegs)
    expect(store.get(sessionDraftsAtom)[b]).toEqual([{ type: 'text', value: 'B draft' }])
  })

  it('clearSessionDraftAtom removes the draft key', () => {
    const store = makeStore()
    const id = store.set(newSessionAtom)
    store.set(setSessionDraftAtom, { id, segments: [{ type: 'text', value: 'x' }] })
    store.set(clearSessionDraftAtom, id)
    expect(store.get(sessionDraftsAtom)[id]).toBeUndefined()
  })

  it('reuses the active draft on consecutive newSession calls', () => {
    const store = makeStore()
    const a = store.set(newSessionAtom)
    const b = store.set(newSessionAtom)
    expect(a).toBe(b)
  })

  it('未实化会话用固定 id —— 重启后 seed 得回盘上的草稿', () => {
    // 回归:draft id 曾是随机 uuid,重启后 bootstrap 建的是新 id,drafts.json
    // 里的旧 key 永远匹配不上 = 用户看到"输入的内容重启后没了"。
    const first = makeStore()
    const id = first.set(newSessionAtom)
    const segments: Segment[] = [{ type: 'text', value: '重启前打的字' }]
    first.set(setSessionDraftAtom, { id, segments })
    const persisted = pruneDrafts(first.get(sessionDraftsAtom))

    // 新一轮启动:全新 store,草稿从盘上灌回,bootstrap 落 Landing。
    const restarted = makeStore()
    restarted.set(setAllDraftsAtom, persisted)
    const afterRestart = restarted.set(newSessionAtom)
    expect(afterRestart).toBe(id)
    expect(restarted.get(sessionDraftsAtom)[afterRestart]).toEqual(segments)
  })

  it('保存时清掉旧版随机 draft id,不误伤 daemon session', () => {
    const kept: Segment[] = [{ type: 'text', value: 'x' }]
    const pruned = pruneDrafts({
      's-99e55a20-2003-4d85-ae72-f88d62fb5263': kept, // 旧版 draft,已成孤儿
      session_20260728_113228_e4e27cad: kept,
      'draft:new': kept,
      's-not-a-uuid': kept, // 形状不符 → 不动它,判定刻意收得紧
    })
    expect(Object.keys(pruned).sort()).toEqual([
      'draft:new',
      's-not-a-uuid',
      'session_20260728_113228_e4e27cad',
    ])
  })

  it('keeps the draft text when newSession reuses the active draft', () => {
    // 回归:「+ 新会话」是从 工作流/Skills/资产 视图回 Landing 的唯一入口,
    // 复用 draft 时清草稿会让「输入 → 切视图 → 切回来」丢掉未发送的内容。
    const store = makeStore()
    const id = store.set(newSessionAtom)
    const segments: Segment[] = [{ type: 'text', value: '帮我查一下昨天的运行结果' }]
    store.set(setSessionDraftAtom, { id, segments })
    expect(store.set(newSessionAtom)).toBe(id)
    expect(store.get(sessionDraftsAtom)[id]).toEqual(segments)
  })
})

describe('pruneDrafts', () => {
  it('drops empty-segment drafts, keeps the rest (incl. unknown sessions)', () => {
    const drafts: Record<string, Segment[]> = {
      keep: [{ type: 'text', value: 'hi' }],
      empty: [{ type: 'text', value: '' }],
      withChip: [{ type: 'mention', id: 'm', label: 'd', group: 'g' }],
    }
    expect(pruneDrafts(drafts)).toEqual({
      keep: [{ type: 'text', value: 'hi' }],
      withChip: [{ type: 'mention', id: 'm', label: 'd', group: 'g' }],
    })
  })
})

describe('updateSessionTitleAtom', () => {
  it('updates title + updatedAt', () => {
    const store = makeStore()
    const id = store.set(newSessionAtom)
    store.set(updateSessionTitleAtom, { id, title: '自定义标题' })
    expect(store.get(sessionsMetaAtom)[0]!.title).toBe('自定义标题')
  })
})

describe('renameSessionAtom', () => {
  it('updates title WITHOUT bumping updatedAt (manual rename must not re-sort)', () => {
    const store = makeStore()
    // A draft (newSession) skips the daemon PATCH — pure synchronous meta update.
    const id = store.set(newSessionAtom)
    const before = store.get(sessionsMetaAtom)[0]!
    store.set(renameSessionAtom, { id, title: '手动改名' })
    const after = store.get(sessionsMetaAtom)[0]!
    expect(after.title).toBe('手动改名')
    // The regression guard: renaming keeps updatedAt, so sidebar order is stable.
    expect(after.updatedAt).toBe(before.updatedAt)
  })
})

describe('sidebarSessionsAtom', () => {
  it('sorts by updatedAt descending', async () => {
    const store = makeStore()
    const a = store.set(newSessionAtom)
    // Materialize a before creating b — otherwise newSessionAtom reuses
    // the existing empty draft (new behavior to avoid dead-session pileup).
    store.set(materializeSessionAtom, a)
    await new Promise((r) => setTimeout(r, 5))
    const b = store.set(newSessionAtom)
    store.set(materializeSessionAtom, b)
    store.set(updateSessionTitleAtom, { id: a, title: 'A bumped' })
    const list = store.get(sidebarSessionsAtom)
    expect(list[0]!.id).toBe(a)
    expect(list[1]!.id).toBe(b)
  })
})

describe('selectSessionAtom', () => {
  it('sets activeSessionIdAtom', () => {
    const store = makeStore()
    const id = store.set(newSessionAtom)
    store.set(activeSessionIdAtom, null)
    store.set(selectSessionAtom, id)
    expect(store.get(activeSessionIdAtom)).toBe(id)
  })
})

describe('hydrateSessionsFromDaemonAtom', () => {
  function withDaemon(store: ReturnType<typeof makeStore>, summaries: unknown[]) {
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify(summaries), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as never
  }

  it('replaces daemon-known rows with the fetched list', async () => {
    const store = makeStore()
    withDaemon(store, [
      { id: 'srv-1', title: '后端会话', tokens: 0, status: 'finish' },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    const ids = store.get(sessionsMetaAtom).map((m) => m.id)
    expect(ids).toEqual(['srv-1'])
  })

  it('re-hydrate preserves local draft rows (gateway-restart resync)', async () => {
    const store = makeStore()
    const draftId = store.set(newSessionAtom) // draft row in _sessionsMeta
    withDaemon(store, [
      { id: 'srv-1', title: '后端会话', tokens: 0, status: 'finish' },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    const ids = store.get(sessionsMetaAtom).map((m) => m.id)
    expect(ids).toContain('srv-1')
    expect(ids).toContain(draftId)
    // draft 仍是 draft(没有被 daemon 行顶掉身份)
    expect(store.get(draftSessionIdsAtom).has(draftId)).toBe(true)
  })

  it('seeds the unread red dot from status="completed"', async () => {
    const store = makeStore()
    withDaemon(store, [
      { id: 'done', title: 'D', tokens: 0, status: 'completed' },
      { id: 'idle', title: 'I', tokens: 0, status: 'finish' },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    const metas = store.get(sessionsMetaAtom)
    expect(metas.find((s) => s.id === 'done')?.hasRedDot).toBe(true)
    expect(metas.find((s) => s.id === 'idle')?.hasRedDot).toBeFalsy()
  })

  it('seeds the pending-interaction flag from status="awaiting"', async () => {
    const store = makeStore()
    withDaemon(store, [
      { id: 'await', title: 'A', tokens: 0, status: 'awaiting' },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    const meta = store.get(sessionsMetaAtom).find((s) => s.id === 'await')
    expect(meta?.hasPendingInteraction).toBe(true)
    // Independent of the unread dot — awaiting interaction with a finished turn.
    expect(meta?.hasRedDot).toBeFalsy()
  })

  it('keeps a blocking Child join running instead of marking it as user interaction', async () => {
    const store = makeStore()
    withDaemon(store, [
      {
        id: 'parent',
        title: 'Parent',
        tokens: 0,
        status: 'running',
        turn_status: 'awaiting_subagents',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    const meta = store.get(sessionsMetaAtom).find((s) => s.id === 'parent')
    expect(meta?.isRunning).toBe(true)
    expect(meta?.turnStatus).toBe('awaiting_subagents')
    expect(meta?.hasPendingInteraction).toBe(false)
    expect(meta?.hasRedDot).toBe(false)
  })

  it('keeps the durable background Child relationship', async () => {
    const store = makeStore()
    withDaemon(store, [
      { id: 'root', title: 'Root', tokens: 0, status: 'finish' },
      {
        id: 'child',
        title: 'Analyze files',
        tokens: 0,
        status: 'awaiting',
        turn_status: 'awaiting_permission',
        parent_session_id: 'root',
        subagent_mode: 'background',
      },
    ])

    await store.set(hydrateSessionsFromDaemonAtom)

    const child = store.get(sessionsMetaAtom).find((session) => session.id === 'child')
    expect(child?.parentSessionId).toBe('root')
    expect(child?.subagentMode).toBe('background')
    expect(child?.turnStatus).toBe('awaiting_permission')
  })
})

describe('pending-interaction icon (markSessionAnsweredAtom)', () => {
  it('clears hasPendingInteraction without a second daemon request', async () => {
    const store = makeStore()
    // Hydrate one awaiting session so the atom has a pending-interaction row.
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)
    const fetchMock = mock(
      async (url: string, init?: { method?: string }) => {
        void init
        // Hydrate returns the list; interaction acceptance travels with its WS answer.
        const isList = new URL(url, 'http://x').pathname === '/sessions'
        return new Response(
          isList
            ? JSON.stringify([
                { id: 'await', title: 'A', tokens: 0, status: 'awaiting' },
              ])
            : null,
          { status: isList ? 200 : 204, headers: { 'content-type': 'application/json' } },
        )
      },
    )
    globalThis.fetch = fetchMock as never
    await store.set(hydrateSessionsFromDaemonAtom)
    const icon = () => store.get(sessionsMetaAtom).find((s) => s.id === 'await')?.hasPendingInteraction
    expect(icon()).toBe(true)

    store.set(markSessionAnsweredAtom, 'await')
    expect(icon()).toBe(false)
    await Promise.resolve()
    const answeredCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/sessions/await/answered'))
    expect(answeredCall).toBeUndefined()
  })
})

describe('unread red dot', () => {
  it('markSessionUnread sets the dot; markSessionRead clears it', () => {
    const store = makeStore()
    const id = store.set(newSessionAtom) // a session row in _sessionsMeta
    const dot = () => store.get(sessionsMetaAtom).find((s) => s.id === id)?.hasRedDot
    expect(dot()).toBeFalsy()
    store.set(markSessionUnreadAtom, id)
    expect(dot()).toBe(true)
    store.set(markSessionReadAtom, id) // clears locally; the POST is a null-safe no-op offline
    expect(dot()).toBe(false)
  })
})

describe('activeIsDraftAtom', () => {
  it('true for a fresh draft, false after materialize / when no active session', () => {
    const store = makeStore()
    expect(store.get(activeIsDraftAtom)).toBe(false) // no active session
    const id = store.set(newSessionAtom)
    expect(store.get(activeIsDraftAtom)).toBe(true)
    store.set(materializeSessionAtom, id)
    expect(store.get(activeIsDraftAtom)).toBe(false)
  })
})

describe('submitSessionDraftAtom — 发送后草稿不被异步回写复活', () => {
  const sent: Segment[] = [{ type: 'text', value: '你好' }]

  it('拦下与刚发送内容相同的迟到回写', () => {
    const store = createStore()
    const id = 's-draft-1'
    store.set(setSessionDraftAtom, { id, segments: sent })

    store.set(submitSessionDraftAtom, { id, text: '你好' })
    expect(store.get(sessionDraftsAtom)[id]).toBeUndefined()

    // useDraftSync 的 300ms 防抖 / 切 session flush 在提交之后才落地，
    // 带着 FreeFormInput 尚未清空的同一份 segments 回写。
    store.set(setSessionDraftAtom, { id, segments: sent })

    expect(store.get(sessionDraftsAtom)[id]).toBeUndefined()
  })

  it('用户提交后新输入的内容照常保存，并解除守卫', () => {
    const store = createStore()
    const id = 's-draft-2'
    store.set(submitSessionDraftAtom, { id, text: '你好' })

    const typed: Segment[] = [{ type: 'text', value: '再来一条' }]
    store.set(setSessionDraftAtom, { id, segments: typed })
    expect(store.get(sessionDraftsAtom)[id]).toEqual(typed)

    // 守卫已退休：此后即便再写入与原消息相同的内容也不再拦。
    store.set(setSessionDraftAtom, { id, segments: sent })
    expect(store.get(sessionDraftsAtom)[id]).toEqual(sent)
  })

  it('换 daemon id 后守卫仍然生效（新会话首条消息的真实路径）', () => {
    const store = createStore()
    const draftId = 's-draft-3'
    const daemonId = 'session_20260726_x'
    store.set(setSessionDraftAtom, { id: draftId, segments: sent })
    store.set(submitSessionDraftAtom, { id: draftId, text: '你好' })

    store.set(replaceDraftWithDaemonIdAtom, { draftId, daemonId })

    // 防抖回写发生在换 id 之后，用的是新 id —— 守卫必须跟着迁移过来，
    // 否则内容会落到新会话的输入框里（这正是用户报的现象）。
    store.set(setSessionDraftAtom, { id: daemonId, segments: sent })

    expect(store.get(sessionDraftsAtom)[daemonId]).toBeUndefined()
    expect(store.get(sessionDraftsAtom)[draftId]).toBeUndefined()
  })

  it('提交后 composer 自己的空回写不退休守卫（守卫要能活过 300ms 防抖清空）', () => {
    const store = createStore()
    const id = 'draft:new'
    store.set(setSessionDraftAtom, { id, segments: sent })
    store.set(submitSessionDraftAtom, { id, text: '你好' })

    // 发送后 ~300ms,useDraftSync 把 FreeFormInput 已清空的内容防抖写回。
    // 空内容指纹('')≠已发送文本,旧实现在这里就把墓碑退休了。
    store.set(setSessionDraftAtom, { id, segments: [{ type: 'text', value: '' }] })

    // 再晚到的一笔携带已发送内容的回写(卸载 flush / 切会话 flush)必须仍被拦下。
    store.set(setSessionDraftAtom, { id, segments: sent })
    const after = store.get(sessionDraftsAtom)[id]
    expect(after === undefined || after.every((s) => s.type === 'text' && s.value === '')).toBe(true)
  })

  it('换 daemon id 后旧 draft id 上的守卫保留（迟到回写仍指向旧 id）', () => {
    const store = createStore()
    const draftId = 'draft:new'
    const daemonId = 'session_20260726_y'
    store.set(setSessionDraftAtom, { id: draftId, segments: sent })
    store.set(submitSessionDraftAtom, { id: draftId, text: '你好' })

    store.set(replaceDraftWithDaemonIdAtom, { draftId, daemonId })

    // useDraftSync 的切会话/卸载 flush 闭包里存的还是旧 id ——
    // 守卫若被"搬走"而不是"复制",这笔回写就会永久留在 draft:new,
    // 之后每次点「新会话」都被 seed 回输入框(用户报的现象)。
    store.set(setSessionDraftAtom, { id: draftId, segments: sent })

    expect(store.get(sessionDraftsAtom)[draftId]).toBeUndefined()
  })

  it('回声窗口过后,用户重新敲出与已发送内容相同的草稿要能存住', () => {
    // 用户报的现象:某会话第一条消息发的就是 "@",此后在这个会话里再打 "@",
    // 切走再切回来就没了 —— 守卫比对命中后直接 return,没走到退休分支,
    // 于是这一整个 app 生命周期内,凡是与已发送文本相同的草稿都写不进去。
    // 守卫要防的只是发送后几百毫秒内的异步回声,超出窗口就该放行。
    const store = createStore()
    const id = 'session_20260812_234103_4662b9d8'
    const at: Segment[] = [{ type: 'text', value: '@' }]
    store.set(submitSessionDraftAtom, { id, text: '@' })
    // 发送后 ~300ms composer 自己的清空回写(不退休守卫)。
    store.set(setSessionDraftAtom, { id, segments: [] })

    setSystemTime(new Date(Date.now() + SUBMIT_ECHO_WINDOW_MS + 1))
    store.set(setSessionDraftAtom, { id, segments: at })
    setSystemTime()

    expect(store.get(sessionDraftsAtom)[id]).toEqual(at)
  })

  it('窗口内的回声仍然拦得住 —— 时间兜底不能削弱原有防线', () => {
    const store = createStore()
    const id = 's-draft-echo'
    store.set(submitSessionDraftAtom, { id, text: '你好' })

    setSystemTime(new Date(Date.now() + SUBMIT_ECHO_WINDOW_MS - 100))
    store.set(setSessionDraftAtom, { id, segments: sent })
    setSystemTime()

    expect(store.get(sessionDraftsAtom)[id]).toBeUndefined()
  })
})
