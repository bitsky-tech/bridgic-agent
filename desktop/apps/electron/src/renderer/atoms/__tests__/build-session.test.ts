import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { createStore } = await import('jotai')
const { activeNavAtom, selectNavAtom } = await import('../amphi')
const { NavKey } = await import('@/components/amphi/LeftSidebar')
const { openBuildSessionAtom } = await import('../workflow-session')
const {
  activeSessionIdAtom,
  pendingComposerFocusAtom,
  pendingComposerSeedAtom,
} = await import('../sessions')

describe('openBuildSessionAtom', () => {
  it('opens a new Session seeded with the /build command and a focused description slot', () => {
    const store = createStore()
    store.set(selectNavAtom, NavKey.Workflows)

    store.set(openBuildSessionAtom)

    expect(store.get(activeNavAtom)).toBe(NavKey.Home)
    const seed = store.get(pendingComposerSeedAtom)
    expect(seed?.sessionId).toBe(store.get(activeSessionIdAtom) ?? '')
    // The command must ride as a slash token, not literal "/build " text: only the
    // token round-trips through the composer DOM and reaches the daemon as a command.
    expect(seed?.segments[0]).toMatchObject({ type: 'slash', id: 'build' })
    expect(seed?.segments.at(-1)).toMatchObject({ type: 'field', id: seed?.focusFieldId })
    expect(store.get(pendingComposerFocusAtom)).toBe(true)
  })
})
