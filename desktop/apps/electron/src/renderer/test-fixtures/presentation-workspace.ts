import {
  createOfficePersistenceScheduler,
} from '@/lib/office/officePersistence'
import type { WorkspacePersistence } from '@/lib/office/workspacePersistence'

export function createMemoryWorkspacePersistence<T>(initial: T | null, sessionId = 'test-session') {
  let stored: T | null = initial === null ? null : structuredClone(initial)
  let beforeWrite: ((workspace: T) => void | Promise<void>) | null = null
  const scheduler = createOfficePersistenceScheduler<T>({
    policy: { appKind: 'presentation', sessionId, kind: 'workspace', storage: 'session-memory', automatic: true },
    delayMs: 150,
    write: async (workspace) => {
      await beforeWrite?.(workspace)
      stored = structuredClone(workspace)
    },
  })
  const persistence: WorkspacePersistence<T> = {
    ...scheduler,
    load: async () => stored === null ? null : structuredClone(stored),
  }
  return {
    persistence,
    read: () => stored === null ? null : structuredClone(stored),
    replace: (value: T | null) => { stored = value === null ? null : structuredClone(value) },
    setBeforeWrite: (effect: ((workspace: T) => void | Promise<void>) | null) => { beforeWrite = effect },
  }
}
