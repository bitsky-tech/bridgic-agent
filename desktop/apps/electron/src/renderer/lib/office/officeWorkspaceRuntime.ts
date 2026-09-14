import type { OfficeAppKind } from './officeSurfaceStatus'

/** Metadata only. The editor continues to own document contents and undo history. */
export interface OfficeDocumentMetadata {
  readonly id: string
  readonly title: string
  readonly revision: number
  readonly dirty: boolean | null
}

export interface OfficeWorkspaceInventory {
  readonly activeDocumentId: string | null
  readonly documents: readonly OfficeDocumentMetadata[]
}

export interface OfficeWorkspaceSnapshot extends OfficeWorkspaceInventory {
  readonly appKind: OfficeAppKind
  readonly sessionId: string
  /** Renderer-lifetime metadata revision, not a durable source-file version. */
  readonly revision: number
  readonly capabilities: readonly string[]
}

export interface OfficeOperation {
  readonly sessionId: string
  readonly capability: string
  readonly documentId?: string | null
  readonly expectedRevision?: number
  readonly expectedDocumentRevision?: number
}

export class OfficeOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OfficeOperationError'
  }
}

export type OfficeOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

export interface OfficeOperationContext {
  readonly sessionId: string
  readonly documentId: string | null
  /** Call after asynchronous preparation, before committing to the editor. */
  assertCurrent(): void
}

export interface OfficeOperationQueue {
  enqueue<T>(operation: () => T | Promise<T>): Promise<T>
  whenIdle(): Promise<void>
}

/** A failed operation cannot poison subsequent work. Native input is never queued here. */
export function createOfficeOperationQueue(): OfficeOperationQueue {
  const pending: Array<() => void> = []
  const idleWaiters = new Set<() => void>()
  let running = false

  const advance = () => {
    const next = pending.shift()
    if (next) {
      running = true
      next()
      return
    }
    running = false
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  return {
    enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        pending.push(() => {
          // Start synchronously when idle, preserving synchronous domain commits.
          try {
            Promise.resolve(operation()).then(
              (value) => { resolve(value); advance() },
              (error: unknown) => { reject(error); advance() },
            )
          } catch (error) {
            reject(error)
            advance()
          }
        })
        if (!running) advance()
      })
    },
    whenIdle: () => running
      ? new Promise<void>((resolve) => { idleWaiters.add(resolve) })
      : Promise.resolve(),
  }
}

export interface OfficeWorkspaceRuntime {
  getSnapshot(): OfficeWorkspaceSnapshot
  publish(): void
  subscribe(listener: (snapshot: OfficeWorkspaceSnapshot) => void): () => void
  supports(capability: string): boolean
  assertCurrent(operation: OfficeOperation): void
  execute<T>(operation: OfficeOperation, apply: (context: OfficeOperationContext) => T | Promise<T>): Promise<OfficeOperationResult<T>>
  whenIdle(): Promise<void>
  dispose(): void
}

export type OfficeWorkspaceReader = Pick<OfficeWorkspaceRuntime, 'getSnapshot' | 'subscribe' | 'supports'>

/** Coordinates explicit operations around a single editor-owned workspace. */
export function createOfficeWorkspaceRuntime(options: {
  appKind: OfficeAppKind
  sessionId: string
  capabilities: readonly string[]
  read: () => OfficeWorkspaceInventory
  queue?: OfficeOperationQueue
}): OfficeWorkspaceRuntime {
  const { appKind, sessionId, read } = options
  const capabilities = Object.freeze([...new Set(options.capabilities)])
  const supported = new Set(capabilities)
  const queue = options.queue ?? createOfficeOperationQueue()
  const listeners = new Set<(snapshot: OfficeWorkspaceSnapshot) => void>()
  let disposed = false
  let snapshot: OfficeWorkspaceSnapshot | null = null
  let publishedRevision = 0

  const getSnapshot = (): OfficeWorkspaceSnapshot => {
    if (disposed && snapshot) return snapshot
    const inventory = read()
    if (snapshot && sameInventory(snapshot, inventory)) return snapshot
    snapshot = Object.freeze({
      appKind,
      sessionId,
      revision: snapshot ? snapshot.revision + 1 : 0,
      capabilities,
      activeDocumentId: inventory.activeDocumentId,
      documents: Object.freeze(inventory.documents.map((document) => Object.freeze({ ...document }))),
    })
    return snapshot
  }

  const publish = () => {
    if (disposed) return
    const next = getSnapshot()
    if (next.revision === publishedRevision) return
    publishedRevision = next.revision
    for (const listener of listeners) listener(next)
  }

  const assertCurrent = (operation: OfficeOperation) => {
    if (disposed) throw new OfficeOperationError('runtime_disposed', 'The Office workspace is no longer available.')
    if (operation.sessionId !== sessionId) throw new OfficeOperationError('session_mismatch', 'The operation belongs to another Session.')
    if (!supported.has(operation.capability)) throw new OfficeOperationError('unsupported_operation', 'This Office workspace does not support the requested operation.')
    for (const revision of [operation.expectedRevision, operation.expectedDocumentRevision]) {
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) {
        throw new OfficeOperationError('invalid_operation', 'Expected revisions must be non-negative integers.')
      }
    }
    const current = getSnapshot()
    const document = operation.documentId == null
      ? null
      : current.documents.find((item) => item.id === operation.documentId)
    if (operation.documentId != null && !document) {
      throw new OfficeOperationError('document_not_found', 'The requested document does not exist in this Session.')
    }
    if (operation.expectedDocumentRevision !== undefined && !document) {
      throw new OfficeOperationError('invalid_operation', 'A document revision requires an explicit document identity.')
    }
    if ((operation.expectedRevision !== undefined && operation.expectedRevision !== current.revision)
      || (operation.expectedDocumentRevision !== undefined && operation.expectedDocumentRevision !== document?.revision)) {
      throw new OfficeOperationError('revision_conflict', 'The Office workspace changed before the operation could be applied.')
    }
  }

  // Establish the initial inventory before an editor publishes its first mutation.
  getSnapshot()
  return {
    getSnapshot,
    publish,
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    supports: (capability) => supported.has(capability),
    assertCurrent,
    execute<T>(operation: OfficeOperation, apply: (context: OfficeOperationContext) => T | Promise<T>): Promise<OfficeOperationResult<T>> {
      // Copy the routing envelope so a caller cannot retarget queued work.
      const bound = Object.freeze({ ...operation })
      return queue.enqueue(async () => {
        try {
          assertCurrent(bound)
          const value = await apply({
            sessionId,
            documentId: bound.documentId ?? null,
            assertCurrent: () => assertCurrent(bound),
          })
          publish()
          return { ok: true as const, value }
        } catch (error) {
          // Drivers can partially mutate before returning a failure; publish those facts too.
          publish()
          return {
            ok: false as const,
            error: {
              code: error instanceof OfficeOperationError ? error.code : 'operation_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
      })
    },
    whenIdle: queue.whenIdle,
    dispose() {
      getSnapshot()
      disposed = true
      listeners.clear()
    },
  }
}

function sameInventory(previous: OfficeWorkspaceInventory, next: OfficeWorkspaceInventory): boolean {
  return previous.activeDocumentId === next.activeDocumentId
    && previous.documents.length === next.documents.length
    && previous.documents.every((document, index) => {
      const candidate = next.documents[index]!
      return document.id === candidate.id && document.title === candidate.title
        && document.revision === candidate.revision && document.dirty === candidate.dirty
    })
}
