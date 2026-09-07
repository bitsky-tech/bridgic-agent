import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Injector, LocaleService } = await import('@univerjs/core')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { BehaviorSubject, Subject } = await import('rxjs')
const {
  ComponentManager,
  ContextMenuPanel,
  ILayoutService,
  IMenuManagerService,
  MenuItemType,
  RediProvider,
} = await import('@univerjs/ui')
type IMenuSchema = import('@univerjs/ui').IMenuSchema

afterEach(() => document.body.replaceChildren())
afterAll(async () => GlobalRegistrator.unregister())

function submenu(id: string, label: string): IMenuSchema {
  return {
    key: id,
    order: 0,
    item: { id, label, type: MenuItemType.SUBITEMS },
  }
}

function command(id: string, label: string): IMenuSchema {
  return {
    key: id,
    order: 0,
    item: { id, label, type: MenuItemType.BUTTON },
  }
}

describe('Univer context-menu submenu hover', () => {
  it('removes the previous sibling submenu in the same render that opens the next one', async () => {
    const menuChanged$ = new Subject<void>()
    const schemas: Record<string, IMenuSchema[]> = {
      root: [{
        key: 'group',
        order: 0,
        children: [submenu('first', 'First'), submenu('second', 'Second')],
      }],
      first: [command('first-action', 'First action')],
      second: [command('second-action', 'Second action')],
    }
    const menuManager = {
      menuChanged$,
      mergeMenu: () => undefined,
      appendRootMenu: () => undefined,
      getMenuByPositionKey: (key: string) => schemas[key] ?? [],
      getFlatMenuByPositionKey: () => [],
    }
    const layoutHost = document.createElement('div')
    document.body.appendChild(layoutHost)
    const layoutService = { rootContainerElement: layoutHost }
    const localeService = {
      direction$: new BehaviorSubject('ltr'),
      t: (key: string) => key,
    }
    const injector = new Injector([
      [LocaleService, { useValue: localeService }],
      [ComponentManager, { useValue: new ComponentManager() }],
      [IMenuManagerService, { useValue: menuManager }],
      [ILayoutService, { useValue: layoutService }],
    ] as never)
    const root = createRoot(layoutHost)

    await act(async () => {
      root.render(
        <RediProvider value={{ injector }}>
          <ContextMenuPanel menuType="root" />
        </RediProvider>,
      )
    })

    const buttons = [...layoutHost.querySelectorAll('button')]
    const first = buttons.find((button) => button.textContent?.includes('First'))
    const second = buttons.find((button) => button.textContent?.includes('Second'))
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    await act(async () => {
      first!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('First action')

    await act(async () => {
      first!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: second }))
      second!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: first }))
    })

    expect(document.body.textContent).not.toContain('First action')
    expect(document.body.textContent).toContain('Second action')

    await act(async () => root.unmount())
    injector.dispose()
    menuChanged$.complete()
  })
})
