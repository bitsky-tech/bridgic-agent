import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { createWordWorkspace } = await import('../wordDomain')
const { createWordWorkspacePersister, loadPersistedWordWorkspace } = await import('../wordPersistence')

afterEach(() => window.localStorage.clear())

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('Word workspace persistence', () => {
  it('falls back to localStorage and reports a completed durable save when IndexedDB is unavailable', async () => {
    const statuses: string[] = []
    const state = createWordWorkspace('session-persisted', 'Untitled')
    const persister = createWordWorkspacePersister((status) => statuses.push(status))

    persister.save(state)
    await persister.flush()

    expect(statuses).toEqual(['saving', 'saved'])
    expect(await loadPersistedWordWorkspace('session-persisted')).toEqual(state)
    persister.dispose()
  })

  it('reports a save error instead of claiming success when every storage backend fails', async () => {
    const statuses: string[] = []
    const localStorage = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError')
        },
      },
    })
    const persister = createWordWorkspacePersister((status) => statuses.push(status))

    persister.save(createWordWorkspace('session-full', 'Untitled'))
    await persister.flush()

    expect(statuses).toEqual(['saving', 'error'])
    Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorage })
    persister.dispose()
  })
})
