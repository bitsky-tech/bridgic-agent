import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { OfficeSurfaceSnapshotSource } from '../useOfficeSurfaceSnapshot'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useOfficeSurfaceSnapshot } = await import('../useOfficeSurfaceSnapshot')
const roots = new Set<Root>()

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount() })
  roots.clear()
  document.body.replaceChildren()
})
afterAll(async () => { await GlobalRegistrator.unregister() })

function Bridge({ source, publish }: { source: OfficeSurfaceSnapshotSource<string>; publish: (value: string) => void }) {
  useOfficeSurfaceSnapshot(source, publish)
  return null
}

function sourceFixture() {
  let push: (value: string) => void = () => undefined
  let resolve!: (value: string) => void
  let reject!: (error: unknown) => void
  let unsubscribed = false
  const errors: unknown[] = []
  const source: OfficeSurfaceSnapshotSource<string> = {
    snapshot: () => new Promise((accept, fail) => { resolve = accept; reject = fail }),
    subscribe: (listener) => {
      push = listener
      return () => { unsubscribed = true }
    },
    onError: (error) => errors.push(error),
  }
  return {
    source, errors,
    push: (value: string) => push(value),
    resolve: (value: string) => resolve(value),
    reject: (error: unknown) => reject(error),
    unsubscribed: () => unsubscribed,
  }
}

async function mountBridge(source: OfficeSurfaceSnapshotSource<string>, publish: (value: string) => void) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.add(root)
  await act(async () => root.render(<Bridge source={source} publish={publish} />))
  return root
}

describe('Office surface inventory subscription', () => {
  it('publishes initial inventory followed by newer lifecycle events', async () => {
    const fixture = sourceFixture()
    const values: string[] = []
    await mountBridge(fixture.source, (value) => values.push(value))
    await act(async () => fixture.resolve('initial'))
    await act(async () => fixture.push('changed'))
    expect(values).toEqual(['initial', 'changed'])
  })

  it('does not overwrite a push with a stale initial inventory', async () => {
    const fixture = sourceFixture()
    const values: string[] = []
    await mountBridge(fixture.source, (value) => values.push(value))
    await act(async () => {
      fixture.push('created')
      fixture.push('closed')
      fixture.resolve('old inventory')
    })
    expect(values).toEqual(['created', 'closed'])
  })

  it('ignores late reads and already-queued pushes after disposal', async () => {
    const fixture = sourceFixture()
    const values: string[] = []
    const root = await mountBridge(fixture.source, (value) => values.push(value))
    await act(async () => root.unmount())
    roots.delete(root)
    await act(async () => {
      fixture.push('queued push')
      fixture.resolve('late inventory')
    })
    expect(fixture.unsubscribed()).toBe(true)
    expect(values).toEqual([])
  })

  it('replaces a source without publishing the previous source read or errors', async () => {
    const previous = sourceFixture()
    const next = sourceFixture()
    const values: string[] = []
    const publish = (value: string) => { values.push(value) }
    const root = await mountBridge(previous.source, publish)
    await act(async () => root.render(<Bridge source={next.source} publish={publish} />))
    await act(async () => {
      previous.push('old queued event')
      previous.reject(new Error('old connection failed'))
      next.resolve('new inventory')
    })
    expect(previous.unsubscribed()).toBe(true)
    expect(previous.errors).toEqual([])
    expect(values).toEqual(['new inventory'])
  })

  it('reports a live initial-read failure while continuing to receive events', async () => {
    const fixture = sourceFixture()
    const values: string[] = []
    const error = new Error('inventory unavailable')
    await mountBridge(fixture.source, (value) => values.push(value))
    await act(async () => fixture.reject(error))
    await act(async () => fixture.push('recovered'))
    expect(fixture.errors).toEqual([error])
    expect(values).toEqual(['recovered'])
  })
})
