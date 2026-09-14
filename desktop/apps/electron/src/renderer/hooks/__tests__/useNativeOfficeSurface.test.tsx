import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { NativeOfficeSurfaceBounds, NativeOfficeSurfaceClient, NativeOfficeSurfacePolicy } from '../useNativeOfficeSurface'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act, useRef } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useNativeOfficeSurface } = await import('../useNativeOfficeSurface')
const roots = new Set<Root>()
const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
const frames = new Map<number, FrameRequestCallback>()
const observers = new Set<FakeResizeObserver>()
let nextFrame = 0

class FakeResizeObserver implements ResizeObserver {
  readonly observed: Element[] = []
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this) }
  observe(element: Element) { this.observed.push(element) }
  unobserve() {}
  disconnect() { observers.delete(this) }
}

beforeEach(() => {
  frames.clear()
  observers.clear()
  globalThis.ResizeObserver = FakeResizeObserver
  globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
})
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount() })
  roots.clear()
  document.body.replaceChildren()
})
afterAll(async () => {
  globalThis.ResizeObserver = originalResizeObserver
  globalThis.requestAnimationFrame = originalRequestAnimationFrame
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  await GlobalRegistrator.unregister()
})

function rect(bounds: NativeOfficeSurfaceBounds): DOMRect {
  return { ...bounds, top: bounds.y, left: bounds.x, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height, toJSON: () => bounds }
}

function fixture() {
  const calls: string[] = []
  const published: (NativeOfficeSurfaceBounds | null)[] = []
  const errors: unknown[] = []
  const client: NativeOfficeSurfaceClient = {
    setBounds: async (bounds) => { calls.push(`bounds:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`) },
    activateSession: async (id) => { calls.push(`activate:${id}`) },
    setVisible: async (visible, focus) => { calls.push(`visible:${visible}:${focus === true}`) },
  }
  const policy: NativeOfficeSurfacePolicy = {
    onError: (error) => { errors.push(error) },
  }
  return {
    client, policy, calls, published, errors,
    publish: (bounds: NativeOfficeSurfaceBounds | null) => { published.push(bounds) },
    bounds: { x: 100, y: 40, width: 600, height: 400 },
    clip: { x: 101, y: 40, width: 599, height: 400 },
  }
}

function Surface({ state, sessionId = 'a', surfaceKey }: { state: ReturnType<typeof fixture>; sessionId?: string | null; surfaceKey?: string }) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  useNativeOfficeSurface({ client: state.client, policy: state.policy, viewportRef, sessionId, surfaceKey, publishBounds: state.publish })
  return <div data-browser-dock-clip ref={(node) => { if (node) node.getBoundingClientRect = () => rect(state.clip) }}>
    <div ref={(node) => {
      viewportRef.current = node
      if (node) node.getBoundingClientRect = () => rect(state.bounds)
    }} />
  </div>
}

async function mount(state: ReturnType<typeof fixture>, sessionId: string | null = 'a') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.add(root)
  await act(async () => root.render(<Surface state={state} sessionId={sessionId} />))
  return root
}

async function flushFrames() {
  await act(async () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(0))
  })
}

describe('native Office surface layout contract', () => {
  it('prepares PPT on its first layout frame and clips its bounds before activating', async () => {
    const state = fixture()
    state.policy.initialSync = 'animation-frame'
    state.policy.prepareSession = async (id) => { state.calls.push(`prepare:${id}`) }
    await mount(state)
    expect(state.calls).toEqual([])
    expect([...observers][0]?.observed).toHaveLength(3)
    await flushFrames()
    expect(state.calls).toEqual(['prepare:a', 'bounds:101:40:599:400', 'activate:a', 'visible:true:false'])
    expect(state.published.at(-1)).toEqual(state.clip)
    await act(async () => window.dispatchEvent(new Event('resize')))
    await flushFrames()
    expect(state.calls).toHaveLength(4)
  })

  it('coalesces resize and scroll updates, hides zero-sized slots, and resumes when visible', async () => {
    const state = fixture()
    await mount(state)
    state.bounds.height = 420
    await act(async () => {
      for (const observer of observers) observer.callback([], observer)
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('scroll'))
    })
    expect(frames.size).toBe(1)
    await flushFrames()
    expect(state.calls.at(-1)).toBe('bounds:101:40:599:420')
    state.bounds.width = 0
    await act(async () => window.dispatchEvent(new Event('resize')))
    await flushFrames()
    expect(state.calls.at(-1)).toBe('visible:false:false')
    expect(state.published.at(-1)).toBeNull()
    state.bounds.width = 600
    await act(async () => window.dispatchEvent(new Event('resize')))
    await flushFrames()
    expect(state.calls.at(-1)).toBe('visible:true:false')
    expect(state.published.at(-1)?.height).toBe(420)
  })

  it('preserves Excel detach behavior while leaving target creation to its config adapter', async () => {
    const state = fixture()
    state.policy.publishBoundsBeforeApply = true
    state.policy.deactivateOnDetach = true
    state.client.setBounds = async (bounds) => {
      expect(state.published.at(-1)).toEqual(bounds)
      state.calls.push('bounds')
    }
    const root = await mount(state)
    await act(async () => root.render(<Surface state={state} sessionId={null} />))
    expect(state.calls).toContain('activate:null')
    expect(state.calls.at(-1)).toBe('visible:false:false')
    expect(state.published.at(-1)).toBeNull()
    expect(observers.size).toBe(0)
  })

  it('does not attach an old Session after preparation resolves during a Session switch', async () => {
    const state = fixture()
    let prepared!: () => void
    state.policy.prepareSession = (id) => id === 'a'
      ? new Promise<void>((resolve) => { prepared = resolve })
      : Promise.resolve()
    const root = await mount(state)
    await act(async () => root.render(<Surface state={state} sessionId="b" />))
    await act(async () => prepared())
    expect(state.calls).not.toContain('activate:a')
    expect(state.calls).toContain('activate:b')
    expect(state.calls.at(-1)).toBe('visible:true:false')
  })

  it('does not publish stale bounds or activate a disposed Session after a bounds acknowledgement', async () => {
    const state = fixture()
    let applied!: () => void
    state.client.setBounds = () => new Promise<void>((resolve) => { applied = resolve })
    const root = await mount(state)
    await act(async () => root.render(<Surface state={state} sessionId={null} />))
    await act(async () => applied())
    expect(state.calls).not.toContain('activate:a')
    expect(state.calls).not.toContain('visible:true:false')
    expect(state.published.every((value) => value === null)).toBe(true)
  })

  it('keeps a new Session rectangle when an old PPT detach acknowledgement arrives late', async () => {
    const state = fixture()
    state.policy.focusHostOnDetach = true
    state.policy.clearBoundsAfterDetach = true
    let hidden!: () => void
    state.client.setVisible = async (visible, focus) => {
      state.calls.push(`visible:${visible}:${focus === true}`)
      if (!visible) await new Promise<void>((resolve) => { hidden = resolve })
    }
    const root = await mount(state)
    state.bounds.height = 450
    await act(async () => root.render(<Surface state={state} sessionId="b" />))
    await act(async () => hidden())
    expect(state.calls).toContain('visible:false:true')
    expect(state.calls).not.toContain('activate:null')
    expect(state.published.at(-1)?.height).toBe(450)
  })

  it('rebinds a recreated target without changing Session identity', async () => {
    const state = fixture()
    state.policy.prepareSession = async (id) => { state.calls.push(`prepare:${id}`) }
    const root = await mount(state)
    await act(async () => root.render(<Surface state={state} surfaceKey="replacement-target" />))
    expect(state.calls.filter((call) => call === 'prepare:a')).toHaveLength(2)
    expect(state.calls.at(-1)).toBe('visible:true:false')
  })

  it('cancels scheduled layout work and observers on unmount', async () => {
    const state = fixture()
    state.policy.initialSync = 'animation-frame'
    const root = await mount(state)
    expect(frames.size).toBe(1)
    await act(async () => root.unmount())
    roots.delete(root)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('scroll'))
    })
    await flushFrames()
    expect(frames.size).toBe(0)
    expect(observers.size).toBe(0)
    expect(state.calls).toEqual(['visible:false:false'])
  })

  for (const operation of ['activate', 'show'] as const) {
    it(`publishes the rectangle again after a failed ${operation} and a retry with unchanged bounds`, async () => {
      const state = fixture()
      const failure = new Error('temporarily unavailable')
      let failing = true
      if (operation === 'activate') {
        state.client.activateSession = async (id) => {
          if (id && failing) throw failure
        }
      } else {
        state.client.setVisible = async (visible) => {
          if (visible && failing) throw failure
        }
      }
      await mount(state)
      expect(state.errors).toEqual([failure])
      expect(state.published.at(-1)).toBeNull()
      failing = false
      await act(async () => window.dispatchEvent(new Event('resize')))
      await flushFrames()
      expect(state.published.at(-1)).toEqual(state.clip)
    })
  }
})
