/**
 * useActiveSessionReadReceipt: navigation conditions for marking a session read only after it is viewed.
 *
 * activeSessionId is independent of navigation. Selecting Schedules or Assets changes only
 * the center pane while activeSessionId still points to the previous session. Completion must
 * not count as viewing it, or the unread mark disappears in the same frame it appears.
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
// atoms/amphi and LeftSidebar form a cycle, while amphi.ts evaluates `Object.values(NavKey)`
// at module scope. Importing LeftSidebar first enters from the wrong side and hits NavKey's TDZ.
// Enter through amphi so LeftSidebar initializes before NavKey is evaluated.
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

/** Create an active unread session in the store and leave navigation at `nav`. */
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
    // While on Schedules, the session is not rendered in the center pane and does not count as viewed.
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
