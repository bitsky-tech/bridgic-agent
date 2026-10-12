import { afterAll, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { LifecycleService, LifecycleStages, type Injector } from '@univerjs/core'
import { DocSelectionManagerService } from '@univerjs/docs'
import { DocCanvasPopManagerService } from '@univerjs/docs-ui'
import type { FDocument } from '@univerjs/docs-ui/facade'
import { IRenderManagerService } from '@univerjs/engine-render'
import { ComponentManager, ICanvasPopupService, IDialogService } from '@univerjs/ui'
import { BehaviorSubject } from 'rxjs'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createWordDomainStore, createWordWorkspace } = await import('../wordDomain')
const { createWordEditorAdapter, mountWordUniverEngine } = await import('../wordEditorAdapter')

afterAll(async () => { await GlobalRegistrator.unregister() })

it('dismisses inactive native portals and reopens the same hyperlink after reactivation', async () => {
  // Only canvas drawing and geometry are headless. The installed Univer engine,
  // popup services, hyperlink commands and portal components remain unchanged.
  const canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
  const elementBounds = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
  const bounds = { x: 0, y: 0, width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, toJSON: () => ({}) }
  const noop = () => undefined
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement) {
      const drawing: Record<string | symbol, unknown> = {
        canvas: this,
        measureText: (text: string) => ({ width: text.length * 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 2 }),
        getLineDash: () => [],
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        createLinearGradient: () => ({ addColorStop: noop }),
        createRadialGradient: () => ({ addColorStop: noop }),
        createPattern: () => null,
      }
      return new Proxy(drawing, {
        get: (target, key) => key in target ? target[key] : noop,
        set: (target, key, value) => { target[key] = value; return true },
      })
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => bounds })
  const store = createWordDomainStore(createWordWorkspace(crypto.randomUUID(), 'First'), { defaultTitle: 'Untitled' })
  const hosts: HTMLDivElement[] = []
  const engines: ReturnType<typeof mountWordUniverEngine>[] = []
  let firstAdapter: ReturnType<typeof createWordEditorAdapter> | undefined
  try {
    await store.dispatch({ type: 'document.update', html: '<p><a href="https://example.com/first">First link</a></p>' })
    const first = store.getSnapshot().documents[0]!
    await store.dispatch({ type: 'document.create', title: 'Second', html: '<p><a href="https://example.com/second">Second link</a></p>' })
    const second = store.getSnapshot().documents[1]!
    await store.dispatch({ type: 'document.activate', documentId: first.id })
    await act(async () => {
      for (const documentState of [first, second]) {
        const host = document.createElement('div')
        document.body.appendChild(host)
        hosts.push(host)
        engines.push(mountWordUniverEngine({ container: host, snapshot: structuredClone(documentState.snapshot), language: 'en' }))
      }
    })
    // The native ready timer starts after React commits the nested UI roots.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    const [firstEngine, secondEngine] = engines
    const injectors = engines.map((engine) => (engine.univerAPI as unknown as { _injector: Injector })._injector)
    for (const injector of injectors) expect(injector.get(LifecycleService).stage).toBeGreaterThanOrEqual(LifecycleStages.Rendered)
    const firstSelection = injectors[0]!.get(DocSelectionManagerService)
    const secondSelection = injectors[1]!.get(DocSelectionManagerService)
    const firstRenderer = injectors[0]!.get(IRenderManagerService).getRenderById(first.id)!.engine
    const nativeFirst = firstEngine!.document as unknown as FDocument
    const anchor = { left: 20, top: 20, right: 80, bottom: 40 }
    for (const injector of injectors) {
      const geometry = injector.get(DocCanvasPopManagerService) as unknown as {
        _createRangePositionObserver(): { positions: typeof anchor[]; positions$: BehaviorSubject<typeof anchor[]>; disposable: { dispose(): void } }
      }
      geometry._createRangePositionObserver = () => ({ positions: [anchor], positions$: new BehaviorSubject([anchor]), disposable: { dispose: noop } })
    }
    const info = (engine: typeof firstEngine) => {
      const range = engine!.document.getSnapshot().body!.customRanges![0]!
      return { unitId: engine!.document.getSnapshot().id, linkId: range.rangeId, segmentId: '', segmentPage: 0, startIndex: range.startIndex, endIndex: range.endIndex }
    }
    const findPopup = (url: string) => Array.from(document.body.querySelectorAll<HTMLElement>('[data-u-comp="rect-popup"]')).find((popup) => popup.textContent?.includes(url))
    await act(async () => {
      firstAdapter = createWordEditorAdapter({ container: hosts[0]!, documentId: first.id, language: 'en', snapshot: first.snapshot, store, zoom: 100, mountNative: () => firstEngine! })
      await new Promise((resolve) => setTimeout(resolve, 50))
      await nativeFirst.appendText(' history')
      await new Promise((resolve) => setTimeout(resolve, 50))
      nativeFirst.setSelection(2, 2)
      secondEngine!.document.setSelection(2, 2)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(firstSelection.getActiveTextRange()).toMatchObject({ startOffset: 2, endOffset: 2, collapsed: true })
    const secondRanges = structuredClone(secondSelection.getDocRanges())
    const firstPopup = findPopup('https://example.com/first')!
    const secondPopup = findPopup('https://example.com/second')!
    expect(firstPopup).toBeDefined()
    expect(secondPopup).toBeDefined()
    expect(hosts[0]!.contains(firstPopup)).toBe(false)
    expect(firstPopup.classList.contains('univer-hidden')).toBe(false)
    expect(Number.parseFloat(firstPopup.style.top)).toBeGreaterThanOrEqual(0)
    expect(Number.parseFloat(firstPopup.style.left)).toBeGreaterThanOrEqual(0)
    const staleUnlink = firstPopup.firstElementChild!.lastElementChild!.lastElementChild as HTMLElement
    const firstPopups = injectors[0]!.get(ICanvasPopupService)
    const components = injectors[0]!.get(ComponentManager)
    const dialog = injectors[0]!.get(IDialogService)
    const customComponent = components.register('word-native-floating-test', () => <div data-testid="word-native-floating-test">Native floating view</div>)
    let dialogs: string[] = []
    const dialogSubscription = dialog.getDialogs$().subscribe((items) => { dialogs = items.filter((item) => item.open).map((item) => item.id) })
    await act(async () => {
      const canvas = injectors[0]!.get(IRenderManagerService).getRenderById(first.id)!.engine.getCanvasElement()
      firstPopups.addPopup({ componentKey: 'word-native-floating-test', unitId: first.id, subUnitId: first.id, canvasElement: canvas, anchorRect$: new BehaviorSubject(anchor) })
      dialog.open({ id: 'word-native-dialog-test', children: { label: 'word-native-floating-test' } })
      await firstEngine!.univerAPI.executeCommand('doc.operation.show-hyper-link-edit-popup', { link: info(firstEngine) })
      nativeFirst.setSelection(2, 2)
      secondEngine!.document.setSelection(2, 2)
    })
    expect(firstPopups.popups.length).toBeGreaterThan(1)
    expect(dialogs).toContain('word-native-dialog-test')
    expect(document.body.querySelector('[data-testid="word-native-floating-test"]')).not.toBeNull()
    await act(async () => {
      await store.dispatch({ type: 'document.activate', documentId: second.id })
      firstAdapter!.setActive(false)
      hosts[0]!.style.visibility = 'hidden'
      secondEngine!.setActive!(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(store.getSnapshot().activeDocumentId).toBe(second.id)
    expect(firstPopups.popups).toHaveLength(0)
    expect(firstSelection.getDocRanges()).toHaveLength(0)
    expect(dialogs).toHaveLength(0)
    expect(findPopup('https://example.com/first')).toBeUndefined()
    expect(firstPopup.isConnected).toBe(false)
    expect(document.body.querySelector('[data-testid="word-native-floating-test"]')).toBeNull()
    // Dismissing one engine must leave the other engine's portal intact.
    expect(findPopup('https://example.com/second')).toBe(secondPopup)
    expect(secondSelection.getDocRanges()).toEqual(secondRanges)
    const activeInput = document.activeElement
    await act(async () => {
      firstAdapter!.setZoom(125)
      firstRenderer.resizeBySize(700, 500)
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(firstSelection.getDocRanges()).toHaveLength(0)
    expect(firstPopups.popups).toHaveLength(0)
    expect(findPopup('https://example.com/first')).toBeUndefined()
    expect(document.activeElement).toBe(activeInput)
    expect(findPopup('https://example.com/second')).toBe(secondPopup)
    await act(async () => staleUnlink.click())
    expect(firstEngine!.document.getSnapshot().body!.customRanges).toHaveLength(1)
    await act(async () => {
      secondEngine!.setActive!(false)
      await store.dispatch({ type: 'document.activate', documentId: first.id })
      hosts[0]!.style.visibility = ''
      firstAdapter!.setActive(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(firstSelection.getActiveTextRange()).toMatchObject({ startOffset: 2, endOffset: 2, collapsed: true })
    const reopenedPopup = findPopup('https://example.com/first')!
    expect(reopenedPopup).toBeDefined()
    expect(reopenedPopup).not.toBe(firstPopup)
    expect(reopenedPopup.classList.contains('univer-hidden')).toBe(false)
    // Switching and selection cleanup must preserve the earlier native edit's undo entry.
    await act(async () => { await nativeFirst.undo() })
    expect(nativeFirst.getSnapshot().body!.dataStream).not.toContain(' history')
    await act(async () => { await nativeFirst.redo(); nativeFirst.setSelection(2, 2) })
    expect(nativeFirst.getSnapshot().body!.dataStream).toContain(' history')
    const activePopup = findPopup('https://example.com/first')!
    await act(async () => (activePopup.firstElementChild!.lastElementChild!.lastElementChild as HTMLElement).click())
    expect(firstEngine!.document.getSnapshot().body!.customRanges).toHaveLength(0)
    dialogSubscription.unsubscribe()
    customComponent.dispose()
  } finally {
    await act(async () => { firstAdapter?.dispose(); for (const engine of engines.slice(firstAdapter ? 1 : 0)) engine.dispose() })
    for (const host of hosts) host.remove()
    store.dispose()
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', canvasContext)
    if (elementBounds) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', elementBounds)
    else delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect
  }
})
