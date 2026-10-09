import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { OfficeLaunchEmptyState } = await import('../OfficeLaunchEmptyState')

afterEach(() => document.body.replaceChildren())
afterAll(async () => { await GlobalRegistrator.unregister() })

describe('OfficeLaunchEmptyState', () => {
  it('uses one layout and the same create/open controls for PPT, Word, and Excel', async () => {
    const kinds = [
      ['presentation', 'powerpoint'],
      ['word', 'word'],
      ['excel', 'excel'],
    ] as const
    const buttonClasses: string[][] = []
    for (const [kind, prefix] of kinds) {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => root.render(
        <OfficeLaunchEmptyState kind={kind} onCreate={() => undefined} onOpen={() => undefined} />,
      ))
      const state = host.querySelector(`[data-testid="${prefix}-launch-empty-state"]`)
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')]
      expect(state).not.toBeNull()
      expect(buttons).toHaveLength(2)
      expect(host.querySelector(`[data-testid="${prefix}-open-file"]`)).not.toBeNull()
      buttonClasses.push(buttons.map((button) => button.className))
      await act(async () => root.unmount())
      host.remove()
    }
    expect(buttonClasses[1]).toEqual(buttonClasses[0])
    expect(buttonClasses[2]).toEqual(buttonClasses[0])
  })

  it('serializes launch actions and reports an open failure without creating a document', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const create = mock(() => undefined)
    let rejectOpen!: (error: Error) => void
    const open = mock(() => new Promise<void>((_resolve, reject) => { rejectOpen = reject }))
    try {
      await act(async () => root.render(<OfficeLaunchEmptyState kind="word" onCreate={create} onOpen={open} />))
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-open-file"]')!.click())
      expect(open).toHaveBeenCalledTimes(1)
      expect([...host.querySelectorAll<HTMLButtonElement>('button')].every((button) => button.disabled)).toBe(true)
      await act(async () => rejectOpen(new Error('Import failed')))
      expect(host.querySelector('[role="alert"]')).not.toBeNull()
      expect(create).not.toHaveBeenCalled()
      expect([...host.querySelectorAll<HTMLButtonElement>('button')].every((button) => !button.disabled)).toBe(true)
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
