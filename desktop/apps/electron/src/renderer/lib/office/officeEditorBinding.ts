import type { OfficeAppKind } from './officeSurfaceStatus'

export interface OfficeEditorIdentity {
  readonly appKind: OfficeAppKind
  readonly sessionId: string
  readonly documentId: string | null
}

/** Capture before asynchronous native work and validate before publishing its result. */
export interface OfficeEditorLease {
  readonly identity: OfficeEditorIdentity
  isCurrent(): boolean
  assertCurrent(): void
}

export class OfficeEditorBindingError extends Error {
  constructor(readonly code: 'editor_not_ready' | 'editor_changed' | 'editor_disposed' | 'editor_already_attached', message: string) {
    super(message)
    this.name = 'OfficeEditorBindingError'
  }
}

export interface OfficeEditorDriver<TSnapshot> {
  /** Read from the existing document authority, without creating a second store. */
  readSnapshot(): TSnapshot | null
  /** Synchronize accepted native edits into the document authority; this is not a disk save. */
  flush(lease: OfficeEditorLease): void | Promise<void>
  /** Release native resources and subscriptions. The caller must flush first when required. */
  dispose(): void
}

export interface OfficeEditorBinding<TSnapshot> {
  attach(driver: OfficeEditorDriver<TSnapshot>): boolean
  capture(): OfficeEditorLease
  bindDocument(documentId: string | null): OfficeEditorLease
  getStatus(): 'loading' | 'ready' | 'disposed'
  readSnapshot(): TSnapshot | null
  publishChange(snapshot: TSnapshot, lease?: OfficeEditorLease): boolean
  flush(): Promise<void>
  dispose(): void
}

/**
 * One mounted engine, one Session, and one active document lease at a time.
 * Native input remains synchronous; operation ordering belongs to the workspace runtime.
 */
export function createOfficeEditorBinding<TSnapshot>(options: OfficeEditorIdentity & {
  onChange?: (snapshot: TSnapshot, identity: OfficeEditorIdentity) => void
}): OfficeEditorBinding<TSnapshot> {
  const { appKind, sessionId, onChange } = options
  let status: 'loading' | 'ready' | 'disposed' = 'loading'
  let driver: OfficeEditorDriver<TSnapshot> | null = null
  let generation = 0

  const createLease = (documentId: string | null): OfficeEditorLease => {
    const capturedGeneration = generation
    return Object.freeze({
      identity: Object.freeze({ appKind, sessionId, documentId }),
      isCurrent: () => status !== 'disposed' && capturedGeneration === generation,
      assertCurrent() {
        if (status === 'disposed') throw new OfficeEditorBindingError('editor_disposed', 'The Office editor has been disposed.')
        if (capturedGeneration !== generation) throw new OfficeEditorBindingError('editor_changed', 'The active Office document changed.')
      },
    })
  }
  let currentLease = createLease(options.documentId)

  return {
    attach(nextDriver) {
      if (status === 'disposed') {
        nextDriver.dispose()
        return false
      }
      if (driver) {
        if (driver === nextDriver) return true
        nextDriver.dispose()
        throw new OfficeEditorBindingError('editor_already_attached', 'An Office editor is already attached to this binding.')
      }
      driver = nextDriver
      status = 'ready'
      return true
    },
    capture: () => currentLease,
    bindDocument(documentId) {
      currentLease.assertCurrent()
      if (currentLease.identity.documentId !== documentId) {
        generation += 1
        currentLease = createLease(documentId)
      }
      return currentLease
    },
    getStatus: () => status,
    readSnapshot() {
      if (!driver || status !== 'ready') return null
      const lease = currentLease
      const snapshot = driver.readSnapshot()
      lease.assertCurrent()
      return snapshot
    },
    publishChange(snapshot, lease = currentLease) {
      if (status !== 'ready' || lease !== currentLease || !lease.isCurrent()) return false
      onChange?.(snapshot, lease.identity)
      return true
    },
    async flush() {
      const lease = currentLease
      lease.assertCurrent()
      if (!driver || status !== 'ready') throw new OfficeEditorBindingError('editor_not_ready', 'The Office editor is not ready.')
      await driver.flush(lease)
      lease.assertCurrent()
    },
    dispose() {
      if (status === 'disposed') return
      status = 'disposed'
      const ownedDriver = driver
      driver = null
      ownedDriver?.dispose()
    },
  }
}
