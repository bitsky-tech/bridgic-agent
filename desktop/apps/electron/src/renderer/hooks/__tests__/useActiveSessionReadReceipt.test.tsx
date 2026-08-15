/**
 * useActiveSessionReadReceipt —— "看过了才算已读" 的 nav 条件。
 *
 * activeSessionId 与 nav 正交:点「调度」/「我的资产」只换中央区,activeSessionId
 * 仍指着上一个会话。此时会话跑完不该被判成"你正在看它"——否则未读对钩在出现的
 * 同一帧就被清掉,用户永远看不到。
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { DEFAULT_SETTINGS } = await import('@app/shared/types')
// atoms/amphi ⇄ LeftSidebar 是循环依赖,且 amphi.ts 顶层就求值 `Object.values(NavKey)`。
// 直接先 import LeftSidebar 会从错误的一端进环 → NavKey TDZ。从 amphi 这端进,
// LeftSidebar 先初始化完,NavKey 才就绪。
const { settingsAtom } = await import('@/atoms/settings')
await import('@/atoms/amphi')
const { NavKey } = await import('@/components/amphi/LeftSidebar')
const {
  activeSessionIdAtom,
  markSessionUnreadAtom,
  newSessionAtom,
  sessionsMetaAtom,
} = await import('@/atoms/sessions')
const { useActiveSessionReadReceipt } = await import('../useActiveSessionReadReceipt')

function Harness() {
  useActiveSessionReadReceipt()
  return null
}

/** Store 里造一个「活跃且带未读点」的会话,并把 nav 停在 `nav`。 */
function makeStore(nav: string) {
  const store = createStore()
  store.set(settingsAtom, {
    ...DEFAULT_SETTINGS,
    ui: { ...DEFAULT_SETTINGS.ui, lastNav: nav },
  })
  const id = store.set(newSessionAtom)
  store.set(activeSessionIdAtom, id)
  store.set(markSessionUnreadAtom, id)
  return { store, id }
}

async function mount(store: ReturnType<typeof createStore>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
  })
  return root
}

function hasRedDot(store: ReturnType<typeof createStore>, id: string): boolean {
  return !!store.get(sessionsMetaAtom).find((s) => s.id === id)?.hasRedDot
}

describe('useActiveSessionReadReceipt', () => {
  it('keeps the unread mark while the user is on a non-Home nav', async () => {
    const { store, id } = makeStore(NavKey.Schedules)
    const root = await mount(store)
    // 人在调度页,中央区根本没渲染这个会话——不算看过。
    expect(hasRedDot(store, id)).toBe(true)
    await act(async () => root.unmount())
  })

  it('clears the unread mark on Home nav (the session is actually on screen)', async () => {
    const { store, id } = makeStore(NavKey.Home)
    const root = await mount(store)
    expect(hasRedDot(store, id)).toBe(false)
    await act(async () => root.unmount())
  })

  it('clears it once the user navigates back Home', async () => {
    const { store, id } = makeStore(NavKey.Schedules)
    const root = await mount(store)
    expect(hasRedDot(store, id)).toBe(true)
    await act(async () => {
      store.set(settingsAtom, {
        ...store.get(settingsAtom),
        ui: { ...store.get(settingsAtom).ui, lastNav: NavKey.Home },
      })
    })
    expect(hasRedDot(store, id)).toBe(false)
    await act(async () => root.unmount())
  })
})
