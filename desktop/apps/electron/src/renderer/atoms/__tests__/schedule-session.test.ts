import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { createStore } = await import('jotai')
const { activeNavAtom } = await import('../amphi')
const { NavKey } = await import('@/components/amphi/LeftSidebar')
const { insertScheduleTemplateInCurrentSessionAtom } = await import('../schedule-session')
const {
  activeSessionIdAtom,
  pendingComposerInsertsAtom,
  pendingComposerSeedAtom,
} = await import('../sessions')

describe('insertScheduleTemplateInCurrentSessionAtom', () => {
  it('keeps the current Session and queues the create template at its composer', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-current')

    store.set(insertScheduleTemplateInCurrentSessionAtom)

    expect(store.get(activeSessionIdAtom)).toBe('session-current')
    expect(store.get(activeNavAtom)).toBe(NavKey.Home)
    expect(store.get(pendingComposerSeedAtom)).toBeNull()
    expect(store.get(pendingComposerInsertsAtom)).toHaveLength(1)
    expect(store.get(pendingComposerInsertsAtom)[0]?.[0]).toMatchObject({ type: 'text' })
  })
})
