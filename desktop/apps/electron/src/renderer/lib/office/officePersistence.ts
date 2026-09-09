import type { OfficeAppKind } from './officeSurfaceStatus'

/** These describe storage guarantees, not the availability of an Agent tool. */
export interface OfficePersistencePolicy {
  readonly appKind: OfficeAppKind
  readonly sessionId: string
  readonly kind: 'recovery' | 'source' | 'export'
  readonly storage: 'browser-storage' | 'session-memory' | 'source-file' | 'download'
  readonly automatic: boolean
}

export interface OfficePersistenceFailure {
  readonly code: string
  readonly message: string
}

export class OfficePersistenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OfficePersistenceError'
  }
}

export interface OfficePersistenceSnapshot {
  readonly policy: OfficePersistencePolicy
  readonly status: 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'disposed'
  readonly pendingCount: number
  readonly error: OfficePersistenceFailure | null
}

export type OfficePersistenceOutcome<T> =
  | { status: 'written'; value: T }
  | { status: 'canceled' }
  | { status: 'conflict'; message: string }
  | { status: 'failed'; error: OfficePersistenceFailure }

export type OfficeRecoveryResult<T> =
  | { status: 'restored'; value: T }
  | { status: 'empty' }
  | { status: 'failed'; error: OfficePersistenceFailure }

/** Keep absence distinct from an unreadable recovery record. */
export async function loadOfficeRecovery<T>(read: () => Promise<T | null>): Promise<OfficeRecoveryResult<T>> {
  try {
    const value = await read()
    return value === null ? { status: 'empty' } : { status: 'restored', value }
  } catch (error) {
    return { status: 'failed', error: persistenceFailure(error) }
  }
}

/** Cancellation/conflict remain explicit and must never acknowledge a saved document. */
export async function runOfficePersistenceOperation<T>(write: () => Promise<OfficePersistenceOutcome<T>>): Promise<OfficePersistenceOutcome<T>> {
  try {
    return await write()
  } catch (error) {
    return { status: 'failed', error: persistenceFailure(error) }
  }
}

export interface OfficePersistenceScheduler<T> {
  schedule(value: T): boolean
  persist(value: T): Promise<void>
  flush(): Promise<void>
  /** Record a snapshot read from storage without rewriting its original file. */
  acknowledge(key: string): void
  getSnapshot(): OfficePersistenceSnapshot
  subscribe(listener: (snapshot: OfficePersistenceSnapshot) => void): () => void
  /** Stop accepting new work and attempt to flush work already accepted. */
  dispose(): void
}

interface PendingWrite<T> {
  value: T
  key: string | undefined
  explicit: boolean
  state: 'pending' | 'writing' | 'saved' | 'failed'
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * A Session-bound writer for one storage destination. Recovery can coalesce unpublished snapshots;
 * source writes can retain every revision. Codecs and destination policy stay local.
 * Do not invoke flush from inside write: it would wait for its own operation.
 */
export function createOfficePersistenceScheduler<T>(options: {
  policy: OfficePersistencePolicy
  write: (value: T) => Promise<void>
  delayMs?: number
  coalesce?: boolean
  key?: (value: T) => string
  onStatusChange?: (snapshot: OfficePersistenceSnapshot) => void
}): OfficePersistenceScheduler<T> {
  const policy = Object.freeze({ ...options.policy })
  const pending: PendingWrite<T>[] = []
  const listeners = new Set<(snapshot: OfficePersistenceSnapshot) => void>()
  let latest: PendingWrite<T> | { key: string; state: 'acknowledged' } | null = null
  let active: PendingWrite<T> | null = null
  let running: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let requestSequence = 0
  let snapshot: OfficePersistenceSnapshot = Object.freeze({ policy, status: 'idle', pendingCount: 0, error: null })

  const publish = (status: OfficePersistenceSnapshot['status'], error: OfficePersistenceFailure | null = null) => {
    snapshot = Object.freeze({ policy, status: disposed ? 'disposed' : status, pendingCount: pending.length + (active ? 1 : 0), error })
    if (disposed) return
    options.onStatusChange?.(snapshot)
    for (const listener of listeners) listener(snapshot)
  }
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const makeWrite = (value: T, explicit: boolean): PendingWrite<T> => {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    // Scheduled checkpoints have no caller awaiting their individual receipt.
    void promise.catch(() => undefined)
    return { value, explicit, key: options.key?.(value), state: 'pending', promise, resolve, reject }
  }

  const enqueue = (value: T, explicit: boolean): PendingWrite<T> | null => {
    requestSequence++
    const key = options.key?.(value)
    if (key !== undefined && latest?.key === key) {
      if (latest.state === 'acknowledged' || latest.state === 'saved') return null
      if (latest.state === 'pending' || latest.state === 'writing') {
        if (explicit) latest.explicit = true
        return latest
      }
    }
    const previous = pending.at(-1)
    // Explicit callers always receive acknowledgement for the exact value requested.
    if (!explicit && options.coalesce !== false && previous && !previous.explicit) {
      previous.value = value
      previous.key = key
      latest = previous
      publish(active ? 'saving' : 'pending')
      return previous
    }
    const job = makeWrite(value, explicit)
    pending.push(job)
    latest = job
    publish(active ? 'saving' : 'pending')
    return job
  }

  const flush = (): Promise<void> => {
    clearTimer()
    if (running) return running
    if (pending.length === 0) return Promise.resolve()
    // Assign running before invoking a driver or subscriber that can schedule more work.
    let failed = false
    let failureSequence = -1
    running = Promise.resolve().then(async () => {
      let lastFailure: { job: PendingWrite<T>; error: unknown } | null = null
      while (pending.length > 0) {
        const job = pending.shift()!
        active = job
        job.state = 'writing'
        publish('saving')
        try {
          await options.write(job.value)
          job.state = 'saved'
          active = null
          // Keep only the deduplication key after acknowledgement, not the document payload.
          if (latest === job) latest = job.key === undefined ? null : { key: job.key, state: 'acknowledged' }
          job.resolve()
        } catch (error) {
          job.state = 'failed'
          active = null
          job.reject(error)
          lastFailure = { job, error }
          // Later writes to this destination must still settle their own receipts.
        }
      }
      if (lastFailure && latest === lastFailure.job) {
        const retry = makeWrite(lastFailure.job.value, false)
        pending.unshift(retry)
        latest = retry
        failed = true
        failureSequence = requestSequence
        clearTimer()
        publish('error', persistenceFailure(lastFailure.error))
        throw lastFailure.error
      }
      publish('saved')
    }).finally(() => {
      running = null
      // A receipt continuation can enqueue after the loop exits but before finally runs.
      if (pending.length > 0 && (!failed || requestSequence > failureSequence)) return flush()
    })
    return running
  }

  return {
    schedule(value) {
      if (disposed) return false
      const job = enqueue(value, false)
      if (!job) return true
      clearTimer()
      timer = setTimeout(() => { timer = null; void flush().catch(() => undefined) }, options.delayMs ?? 120)
      return true
    },
    persist(value) {
      if (disposed) return Promise.reject(new OfficePersistenceError('disposed', 'This Office persistence channel is closed.'))
      const job = enqueue(value, true)
      if (!job) return Promise.resolve()
      void flush().catch(() => undefined)
      return job.promise
    },
    flush,
    acknowledge(key) {
      if (disposed) return
      latest = { key, state: 'acknowledged' }
      if (!active && pending.length === 0) publish('saved')
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimer()
      listeners.clear()
      publish('disposed')
      void flush().catch(() => undefined)
    },
  }
}

function persistenceFailure(error: unknown): OfficePersistenceFailure {
  return Object.freeze({
    code: error instanceof OfficePersistenceError ? error.code : 'persistence_failed',
    message: error instanceof Error ? error.message : String(error),
  })
}
