import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Dispatch, SetStateAction } from 'react'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act, StrictMode, useEffect, useLayoutEffect, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { DebugDraftProvider, useDebugDraft } = await import('../DebugDrafts')

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  document.body.replaceChildren()
})
afterAll(async () => { await GlobalRegistrator.unregister() })

interface RenderState {
  sessionId: string | null
  draftKey?: string
  recorded?: string
  visible?: boolean
}

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  let draft!: { value: string; setValue: Dispatch<SetStateAction<string>> }
  let application!: { value: number; setValue: Dispatch<SetStateAction<number>> }
  const lifecycle = { mounts: 0, unmounts: 0 }

  function Inspector({ draftKey, recorded }: { draftKey: string; recorded: string }) {
    const [value, setValue] = useDebugDraft(draftKey, () => recorded)
    useLayoutEffect(() => { draft = { value, setValue } }, [value, setValue])
    return <output data-testid="draft">{value}</output>
  }

  function Application({ draftKey = 'tool:call-a', recorded = 'recorded', visible = true }: RenderState) {
    const [value, setValue] = useState(0)
    useLayoutEffect(() => { application = { value, setValue } }, [value, setValue])
    useEffect(() => {
      lifecycle.mounts += 1
      return () => { lifecycle.unmounts += 1 }
    }, [])
    return <div><output data-testid="application">{value}</output>
      {visible ? <Inspector draftKey={draftKey} recorded={recorded} /> : <span>Inspector list</span>}
    </div>
  }

  const render = async (state: RenderState) => act(async () => root.render(
    <StrictMode><DebugDraftProvider sessionId={state.sessionId}>
      <Application {...state} />
    </DebugDraftProvider></StrictMode>,
  ))
  await render({ sessionId: 'session-a' })
  return { render, draft: () => draft, application: () => application, lifecycle }
}

describe('DebugDraftProvider lifecycle', () => {
  it('rejects old value and functional setters after Session A → B → A', async () => {
    const view = await mount()
    const oldA = view.draft().setValue
    await act(async () => oldA('edited A'))
    await view.render({ sessionId: 'session-b', recorded: 'recorded B' })
    const oldB = view.draft().setValue
    await act(async () => oldA('stale A overwrite'))
    expect(view.draft().value).toBe('recorded B')

    await view.render({ sessionId: 'session-a', recorded: 'fresh A' })
    let staleUpdaterCalls = 0
    await act(async () => {
      oldA(() => { staleUpdaterCalls += 1; return 'stale A updater' })
      oldB('stale B overwrite')
    })
    expect(staleUpdaterCalls).toBe(0)
    expect(view.draft().value).toBe('fresh A')
    await act(async () => view.draft().setValue(value => `${value} edited`))
    expect(view.draft().value).toBe('fresh A edited')
  })

  it('keeps edits through polling, inspector remounts, and visits to another draft key', async () => {
    const view = await mount()
    await act(async () => view.draft().setValue('local edit'))
    await view.render({ sessionId: 'session-a', recorded: 'polled replacement' })
    expect(view.draft().value).toBe('local edit')
    await view.render({ sessionId: 'session-a', visible: false })
    await view.render({ sessionId: 'session-a', recorded: 'polled after remount' })
    expect(view.draft().value).toBe('local edit')
    await view.render({ sessionId: 'session-a', draftKey: 'model:round-b', recorded: 'model request' })
    expect(view.draft().value).toBe('model request')
    await act(async () => view.draft().setValue('model edit'))
    await view.render({ sessionId: 'session-a', recorded: 'newest recorded value' })
    expect(view.draft().value).toBe('local edit')
    await view.render({ sessionId: 'session-a', draftKey: 'model:round-b' })
    expect(view.draft().value).toBe('model edit')
  })

  it('resets only drafts while the wrapped application keeps its mount and local state', async () => {
    const view = await mount()
    // StrictMode intentionally mounts effects twice initially; later Session
    // changes must not add another mount/cleanup cycle to the application.
    const initialLifecycle = { ...view.lifecycle }
    await act(async () => {
      view.application().setValue(7)
      view.draft().setValue('edited draft')
    })
    for (const sessionId of ['session-a', 'session-b', null, 'session-a']) {
      await view.render({ sessionId, recorded: 'fresh recorded value' })
      expect(view.application().value).toBe(7)
      expect(view.lifecycle).toEqual(initialLifecycle)
    }
    expect(view.draft().value).toBe('fresh recorded value')
  })
})
