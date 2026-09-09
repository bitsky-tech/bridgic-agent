import type { WordWorkspaceState } from './wordDomain'
import { createOfficePersistenceScheduler, type OfficePersistenceSnapshot } from './office/officePersistence'

const WORD_DATABASE_NAME = 'bridgic-word'
const WORD_DATABASE_VERSION = 1
const WORD_STORE_NAME = 'workspaces'
const WORD_STORAGE_PREFIX = 'bridgic.word.workspace.'
const WORD_RECOVERY_METADATA = '__bridgicWordRecovery'

interface PersistedWordWorkspace extends Record<string, unknown> {
  sessionId: string
  documents: Array<Record<string, unknown> & { id: string; updatedAt: number }>
}

interface WordRecoveryCheckpoint {
  version: 1
  sequence: number
  legacyAlternatives?: PersistedWordWorkspace[]
}

interface WordRecoveryRecord {
  workspace: PersistedWordWorkspace
  checkpoint: WordRecoveryCheckpoint | null
}

// Each native Word renderer owns one Session. These fields never enter the document domain.
const recoveryCheckpoints = new Map<string, WordRecoveryCheckpoint>()

export type WordPersistenceStatus = 'error' | 'saved' | 'saving'

export interface WordWorkspacePersister {
  dispose(): void
  flush(): Promise<void>
  save(state: WordWorkspaceState): void
  getSnapshot(): OfficePersistenceSnapshot
  subscribe(listener: (snapshot: OfficePersistenceSnapshot) => void): () => void
}

export async function loadPersistedWordWorkspace(sessionId: string): Promise<unknown | null> {
  const key = `${WORD_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`
  let fallbackText: string | null = null
  let fallbackError: unknown
  try {
    fallbackText = window.localStorage.getItem(key)
  } catch (error) {
    fallbackError = error
  }
  const fallback = fallbackText === null ? null : recoveryRecord(JSON.parse(fallbackText) as unknown, sessionId)
  let indexed: WordRecoveryRecord | null = null
  let indexedError: unknown
  try {
    if (window.indexedDB) {
      const value = await readIndexedWorkspace(sessionId)
      if (value !== null) indexed = recoveryRecord(value, sessionId)
    }
  } catch (error) {
    indexedError = error
  }

  // Opening an older fallback for editing would let the next save overwrite an unread
  // primary. Use the existing restore retry until both available stores can be compared.
  if (indexedError) throw indexedError
  if (!fallback && !indexed) {
    if (fallbackError) throw fallbackError
    return null
  }
  const checkpoint = rememberCheckpoints(sessionId, [indexed, fallback])
  let selection: 'indexed' | 'fallback' | 'ambiguous' = indexed ? 'indexed' : 'fallback'
  if (indexed && fallback) selection = selectRecoveryRecord(indexed, fallback)
  if (selection !== 'fallback') {
    if (selection === 'ambiguous') {
      // Old records cannot order closes or same-millisecond edits. Keep the old primary
      // preference and retain the alternative through subsequent writes to either store.
      retainLegacyAlternative(checkpoint, fallback!.workspace)
    } else if (fallback && containsAlternatives(indexed!.checkpoint, checkpoint)) {
      try { window.localStorage.removeItem(key) } catch { /* The selected IndexedDB record remains intact. */ }
    }
    return indexed!.workspace
  }

  if (window.indexedDB) {
    try {
      await writeIndexedWorkspace(sessionId, checkpointRecord(fallback!.workspace, sessionId))
      window.localStorage.removeItem(key)
    } catch {
      // Keep the fallback until its IndexedDB migration is durably acknowledged.
    }
  }
  return fallback!.workspace
}

function recoveryRecord(value: unknown, sessionId: string): WordRecoveryRecord {
  validatePersistedWorkspace(value, sessionId)
  const { [WORD_RECOVERY_METADATA]: metadata, ...workspace } = value
  if (metadata === undefined) return { workspace: workspace as PersistedWordWorkspace, checkpoint: null }
  const checkpoint = metadata as WordRecoveryCheckpoint
  if (!checkpoint || typeof checkpoint !== 'object' || checkpoint.version !== 1
    || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0
    || (checkpoint.legacyAlternatives !== undefined && !Array.isArray(checkpoint.legacyAlternatives))) {
    throw new Error('The saved Word recovery checkpoint is invalid.')
  }
  for (const alternative of checkpoint.legacyAlternatives ?? []) validatePersistedWorkspace(alternative, sessionId)
  return { workspace: workspace as PersistedWordWorkspace, checkpoint }
}

function rememberCheckpoints(sessionId: string, records: Array<WordRecoveryRecord | null>): WordRecoveryCheckpoint {
  const checkpoint = recoveryCheckpoints.get(sessionId) ?? { version: 1, sequence: 0 }
  for (const record of records) {
    checkpoint.sequence = Math.max(checkpoint.sequence, record?.checkpoint?.sequence ?? 0)
    for (const alternative of record?.checkpoint?.legacyAlternatives ?? []) retainLegacyAlternative(checkpoint, alternative)
  }
  recoveryCheckpoints.set(sessionId, checkpoint)
  return checkpoint
}

function retainLegacyAlternative(checkpoint: WordRecoveryCheckpoint, workspace: PersistedWordWorkspace): void {
  const { [WORD_RECOVERY_METADATA]: _metadata, ...alternative } = workspace
  const alternatives = checkpoint.legacyAlternatives ?? []
  if (!alternatives.some((entry) => JSON.stringify(entry) === JSON.stringify(alternative))) {
    checkpoint.legacyAlternatives = [...alternatives, alternative as PersistedWordWorkspace]
  }
}

function containsAlternatives(record: WordRecoveryCheckpoint | null, retained: WordRecoveryCheckpoint): boolean {
  return (retained.legacyAlternatives ?? []).every((alternative) =>
    record?.legacyAlternatives?.some((entry) => JSON.stringify(entry) === JSON.stringify(alternative)))
}

function selectRecoveryRecord(indexed: WordRecoveryRecord, fallback: WordRecoveryRecord): 'indexed' | 'fallback' | 'ambiguous' {
  const primarySequence = indexed.checkpoint?.sequence ?? -1
  const fallbackSequence = fallback.checkpoint?.sequence ?? -1
  if (primarySequence !== fallbackSequence) return primarySequence > fallbackSequence ? 'indexed' : 'fallback'
  if (JSON.stringify(indexed.workspace.documents) === JSON.stringify(fallback.workspace.documents)) return 'indexed'

  // Per-document times can order content only when both legacy workspaces contain the
  // same documents. A missing document may have been closed; it is not an older edit.
  const newerDocuments = (candidate: PersistedWordWorkspace, previous: PersistedWordWorkspace) => {
    if (candidate.documents.length !== previous.documents.length) return false
    const previousById = new Map(previous.documents.map((document) => [document.id, document]))
    let newer = false
    for (const document of candidate.documents) {
      const prior = previousById.get(document.id)
      if (!prior || document.updatedAt < prior.updatedAt) return false
      if (document.updatedAt === prior.updatedAt && JSON.stringify(document) !== JSON.stringify(prior)) return false
      if (document.updatedAt > prior.updatedAt) newer = true
    }
    return newer
  }
  if (newerDocuments(indexed.workspace, fallback.workspace)) return 'indexed'
  if (newerDocuments(fallback.workspace, indexed.workspace)) return 'fallback'
  return 'ambiguous'
}

function checkpointRecord(workspace: WordWorkspaceState | PersistedWordWorkspace, sessionId: string) {
  const checkpoint = rememberCheckpoints(sessionId, [])
  checkpoint.sequence = Math.max(Date.now(), checkpoint.sequence + 1)
  return { ...workspace, [WORD_RECOVERY_METADATA]: { ...checkpoint } }
}

export function createWordWorkspacePersister(sessionId: string, onStatusChange: (status: WordPersistenceStatus) => void): WordWorkspacePersister {
  let lastStatus: WordPersistenceStatus | undefined
  const scheduler = createOfficePersistenceScheduler<WordWorkspaceState>({
    policy: { appKind: 'word', sessionId, kind: 'recovery', storage: 'browser-storage', automatic: true },
    delayMs: 120,
    write: persistWordWorkspace,
    onStatusChange: ({ status }) => {
      let next: WordPersistenceStatus
      if (status === 'error') next = 'error'
      else if (status === 'saved') next = 'saved'
      else if (status === 'pending' || status === 'saving') next = 'saving'
      else return
      if (next !== lastStatus) { lastStatus = next; onStatusChange(next) }
    },
  })
  return {
    dispose: scheduler.dispose,
    flush: scheduler.flush,
    getSnapshot: scheduler.getSnapshot,
    subscribe: scheduler.subscribe,
    save(state) {
      if (state.sessionId !== sessionId) throw new Error('The Word workspace belongs to another Session.')
      scheduler.schedule(state)
    },
  }
}

/** Reject unreadable recovery records before a blank workspace can replace them. */
function validatePersistedWorkspace(value: unknown, sessionId: string): asserts value is PersistedWordWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The saved Word workspace is invalid.')
  const workspace = value as Record<string, unknown>
  if (workspace.sessionId !== sessionId || (workspace.version !== 1 && workspace.version !== 2) || !Array.isArray(workspace.documents)) {
    throw new Error('The saved Word workspace is incompatible with this Session.')
  }
  const ids = new Set<string>()
  for (const entry of workspace.documents) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('The saved Word document is invalid.')
    const document = entry as Record<string, unknown>
    if (typeof document.id !== 'string' || !document.id || ids.has(document.id) || typeof document.title !== 'string'
      || typeof document.createdAt !== 'number' || !Number.isFinite(document.createdAt)
      || typeof document.updatedAt !== 'number' || !Number.isFinite(document.updatedAt)) {
      throw new Error('The saved Word document metadata is invalid.')
    }
    ids.add(document.id)
    if (workspace.version === 1) {
      if (typeof document.html !== 'string') throw new Error('The saved Word document content is invalid.')
    } else {
      const snapshot = document.snapshot as Record<string, unknown> | null
      const body = snapshot?.body as Record<string, unknown> | null
      if (!snapshot || typeof snapshot !== 'object' || !snapshot.documentStyle || typeof snapshot.documentStyle !== 'object'
        || !body || typeof body !== 'object' || typeof body.dataStream !== 'string') {
        throw new Error('The saved Word document content is invalid.')
      }
    }
  }
}

async function persistWordWorkspace(state: WordWorkspaceState): Promise<void> {
  const record = checkpointRecord(state, state.sessionId)
  try {
    await writeIndexedWorkspace(state.sessionId, record)
    // Remove a previous fallback so future reads cannot prefer an older local copy.
    try { window.localStorage.removeItem(`${WORD_STORAGE_PREFIX}${encodeURIComponent(state.sessionId)}`) } catch { /* IndexedDB is already durable. */ }
    return
  } catch (indexedDbError) {
    try {
      window.localStorage.setItem(
        `${WORD_STORAGE_PREFIX}${encodeURIComponent(state.sessionId)}`,
        JSON.stringify(record),
      )
      return
    } catch {
      throw indexedDbError
    }
  }
}

async function readIndexedWorkspace(sessionId: string): Promise<unknown | null> {
  const database = await openWordDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(WORD_STORE_NAME, 'readonly')
      const request = transaction.objectStore(WORD_STORE_NAME).get(sessionId)
      request.onerror = () => reject(request.error ?? new Error('Unable to read the Word workspace.'))
      request.onsuccess = () => resolve(request.result ?? null)
    })
  } finally {
    database.close()
  }
}

async function writeIndexedWorkspace(sessionId: string, state: unknown): Promise<void> {
  const database = await openWordDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(WORD_STORE_NAME, 'readwrite')
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to save the Word workspace.'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save the Word workspace.'))
      transaction.oncomplete = () => resolve()
      transaction.objectStore(WORD_STORE_NAME).put(state, sessionId)
    })
  } finally {
    database.close()
  }
}

async function openWordDatabase(): Promise<IDBDatabase> {
  if (!window.indexedDB) throw new Error('IndexedDB is unavailable.')
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(WORD_DATABASE_NAME, WORD_DATABASE_VERSION)
    request.onerror = () => reject(request.error ?? new Error('Unable to open Word storage.'))
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WORD_STORE_NAME)) {
        request.result.createObjectStore(WORD_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}
