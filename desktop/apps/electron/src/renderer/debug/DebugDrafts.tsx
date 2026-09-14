import { createContext, useCallback, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

interface DraftScope {
  sessionId: string | null
}
interface DraftState {
  scope: DraftScope
  values: Map<string, unknown>
}
interface DraftContext extends DraftState {
  update: (key: string, initial: unknown, action: unknown | ((previous: unknown) => unknown)) => void
}
const Context = createContext<DraftContext | null>(null)

/** Keep edited requests across inspector navigation without persisting into Session history. */
export function DebugDraftProvider({ sessionId, children }: { sessionId: string | null; children: ReactNode }) {
  const [state, setState] = useState<DraftState>(() => ({ scope: { sessionId }, values: new Map() }))
  if (state.scope.sessionId !== sessionId) setState({ scope: { sessionId }, values: new Map() })
  const { scope } = state
  const update = useCallback<DraftContext['update']>((key, initial, action) => {
    setState(current => {
      // An old inspector callback must not edit a newly selected Session.
      if (current.scope !== scope) return current
      const previous = current.values.has(key) ? current.values.get(key) : initial
      const next = typeof action === 'function' ? action(previous) : action
      if (current.values.has(key) && Object.is(previous, next)) return current
      const values = new Map(current.values)
      values.set(key, next)
      return { scope, values }
    })
  }, [scope])
  return <Context.Provider value={{ ...state, update }}>{children}</Context.Provider>
}

export function useDebugDraft<T>(key: string, initial: () => T): [T, Dispatch<SetStateAction<T>>] {
  const context = useContext(Context)
  if (!context) throw new Error('DebugDraftProvider is required')
  const [seed, setSeed] = useState(() => ({ scope: context.scope, key, value: initial() }))
  let currentSeed = seed
  if (seed.scope !== context.scope || seed.key !== key) {
    currentSeed = { scope: context.scope, key, value: initial() }
    setSeed(currentSeed)
  }
  const value = context.values.has(key) ? context.values.get(key) as T : currentSeed.value
  const { update } = context
  const initialValue = currentSeed.value
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(action => {
    update(key, initialValue, action as unknown)
  }, [update, key, initialValue])
  return [value, setValue]
}
