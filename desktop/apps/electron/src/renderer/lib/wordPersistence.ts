import type { WordWorkspaceState } from './wordDomain'
import type { OfficePersistenceSnapshot } from './office/officePersistence'
import { createIndexedDbWorkspacePersistence } from './office/workspacePersistence'

export type WordPersistenceStatus = 'error' | 'saved' | 'saving'

export interface WordWorkspacePersister {
  dispose(): void
  flush(): Promise<void>
  persist(state: WordWorkspaceState): Promise<void>
  save(state: WordWorkspaceState): void
  getSnapshot(): OfficePersistenceSnapshot
  subscribe(listener: (snapshot: OfficePersistenceSnapshot) => void): () => void
}

function createWordPersistence(sessionId: string) {
  return createIndexedDbWorkspacePersistence<WordWorkspaceState>({
    appKind: 'word',
    databaseName: 'bridgic-word',
    sessionId,
    storeName: 'workspaces',
    delayMs: 120,
  })
}

export async function loadPersistedWordWorkspace(sessionId: string): Promise<WordWorkspaceState | null> {
  const persistence = createWordPersistence(sessionId)
  try {
    const workspace = await persistence.load()
    if (workspace !== null) validatePersistedWorkspace(workspace, sessionId)
    return workspace
  } finally {
    persistence.dispose()
  }
}

export function createWordWorkspacePersister(sessionId: string, onStatusChange: (status: WordPersistenceStatus) => void): WordWorkspacePersister {
  const persistence = createWordPersistence(sessionId)
  let lastStatus: WordPersistenceStatus | undefined
  const unsubscribe = persistence.subscribe(({ status }) => {
    let next: WordPersistenceStatus | undefined
    if (status === 'error') next = 'error'
    else if (status === 'saved') next = 'saved'
    else if (status === 'pending' || status === 'saving') next = 'saving'
    if (next && next !== lastStatus) { lastStatus = next; onStatusChange(next) }
  })
  const assertSession = (state: WordWorkspaceState) => {
    if (state.sessionId !== sessionId) throw new Error('The Word workspace belongs to another Session.')
  }
  return {
    dispose() { unsubscribe(); persistence.dispose() },
    flush: persistence.flush,
    async persist(state) { assertSession(state); await persistence.persist(state) },
    save(state) { assertSession(state); persistence.schedule(state) },
    getSnapshot: persistence.getSnapshot,
    subscribe: persistence.subscribe,
  }
}

/** Reject damaged current-schema records before an empty workspace can replace them. */
function validatePersistedWorkspace(value: unknown, sessionId: string): asserts value is WordWorkspaceState {
  const isRecord = (entry: unknown): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
  if (!isRecord(value)) throw new Error('The saved Word workspace is invalid.')
  if (value.sessionId !== sessionId || value.version !== 2 || !Array.isArray(value.documents)) {
    throw new Error('The saved Word workspace is incompatible with this Session.')
  }
  const ids = new Set<string>()
  for (const entry of value.documents) {
    if (!isRecord(entry)) throw new Error('The saved Word document is invalid.')
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.title !== 'string'
      || typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)
      || typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)
      || !isRecord(entry.page) || !isRecord(entry.headerFooter) || !Array.isArray(entry.footnotes) || !Array.isArray(entry.citations)
      || [entry.contentVersion, entry.savedContentVersion].some((version) => version !== undefined && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0))
      || (entry.sourcePath !== undefined && (typeof entry.sourcePath !== 'string' || !entry.sourcePath.trim()))
      || (entry.sourceMtimeMs !== undefined && (typeof entry.sourceMtimeMs !== 'number' || !Number.isFinite(entry.sourceMtimeMs) || entry.sourceMtimeMs < 0))
      || (entry.sourceProtected !== undefined && typeof entry.sourceProtected !== 'boolean')) {
      throw new Error('The saved Word document metadata is invalid.')
    }
    ids.add(entry.id)
    const snapshot = entry.snapshot
    if (!isRecord(snapshot) || snapshot.id !== entry.id || !isRecord(snapshot.documentStyle)
      || !isRecord(snapshot.body) || typeof snapshot.body.dataStream !== 'string') {
      throw new Error('The saved Word document content is invalid.')
    }
  }
  if (typeof value.activeDocumentId !== 'string'
    || (ids.size > 0 ? !ids.has(value.activeDocumentId) : value.activeDocumentId !== '')) {
    throw new Error('The saved Word workspace has an invalid document inventory.')
  }
}
