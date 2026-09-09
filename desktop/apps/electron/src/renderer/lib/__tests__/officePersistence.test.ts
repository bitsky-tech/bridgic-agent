import { describe, expect, it } from 'bun:test'
import {
  createOfficePersistenceScheduler,
  loadOfficeRecovery,
  OfficePersistenceError,
  runOfficePersistenceOperation,
  type OfficePersistencePolicy,
} from '../office/officePersistence'

const policy: OfficePersistencePolicy = {
  appKind: 'word', sessionId: 'session-a', kind: 'recovery', storage: 'browser-storage', automatic: true,
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('Office persistence scheduling', () => {
  it('coalesces recovery snapshots waiting behind an in-flight write and flushes the latest accepted value', async () => {
    const started = deferred()
    const gate = deferred()
    const writes: number[] = []
    const scheduler = createOfficePersistenceScheduler({ policy, delayMs: 60_000, write: async (value: number) => {
      writes.push(value)
      if (value === 1) { started.resolve(); await gate.promise }
    } })
    scheduler.schedule(1)
    const flush = scheduler.flush()
    await started.promise
    scheduler.schedule(2)
    scheduler.schedule(3)
    expect(scheduler.getSnapshot()).toMatchObject({ status: 'saving', pendingCount: 2 })
    gate.resolve()
    await flush
    expect(writes).toEqual([1, 3])
    expect(scheduler.getSnapshot()).toMatchObject({ status: 'saved', pendingCount: 0, error: null, policy })
    scheduler.dispose()
  })

  it('makes a same-key explicit write wait for the scheduled write acknowledgement', async () => {
    const started = deferred()
    const gate = deferred()
    let calls = 0
    let acknowledged = false
    const scheduler = createOfficePersistenceScheduler({ policy, key: String, write: async (_value: number) => {
      calls++; started.resolve(); await gate.promise
    } })
    scheduler.schedule(1)
    const firstFlush = scheduler.flush()
    await started.promise
    const receipt = scheduler.persist(1).then(() => { acknowledged = true })
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    gate.resolve()
    await Promise.all([firstFlush, receipt])
    expect(acknowledged).toBe(true)
    expect(calls).toBe(1)
    await scheduler.persist(1)
    expect(calls).toBe(1)
    scheduler.dispose()
  })

  it('does not coalesce explicit receipts or skip a revision repeated after a different write', async () => {
    const writes: string[] = []
    const scheduler = createOfficePersistenceScheduler({ policy, key: String, write: async (value: string) => { writes.push(value) } })
    const first = scheduler.persist('a')
    const second = scheduler.persist('b')
    scheduler.schedule('a')
    await Promise.all([first, second, scheduler.flush()])
    expect(writes).toEqual(['a', 'b', 'a'])
    scheduler.dispose()
  })

  it('retains all source revisions when coalescing is disabled', async () => {
    const writes: number[] = []
    const scheduler = createOfficePersistenceScheduler({
      policy: { ...policy, appKind: 'presentation', kind: 'source', storage: 'source-file' },
      coalesce: false, write: async (value: number) => { writes.push(value) },
    })
    scheduler.schedule(1)
    scheduler.schedule(2)
    scheduler.schedule(3)
    await scheduler.flush()
    expect(writes).toEqual([1, 2, 3])
    scheduler.dispose()
  })

  it('rejects a failed receipt but keeps later writes moving toward the newest destination state', async () => {
    const writes: string[] = []
    const scheduler = createOfficePersistenceScheduler({ policy, write: async (value: string) => {
      writes.push(value)
      if (value === 'old') throw new Error('Old write failed')
    } })
    const first = scheduler.persist('old')
    const second = scheduler.persist('latest')
    const flush = scheduler.flush()
    await expect(first).rejects.toThrow('Old write failed')
    await second
    await flush
    expect(writes).toEqual(['old', 'latest'])
    expect(scheduler.getSnapshot()).toMatchObject({ status: 'saved', pendingCount: 0, error: null })
    scheduler.dispose()
  })

  it('retains the latest failed snapshot for an explicit retry without a retry loop', async () => {
    let calls = 0
    const scheduler = createOfficePersistenceScheduler({ policy, key: String, write: async (_value: number) => {
      calls++
      if (calls === 1) throw new OfficePersistenceError('storage_full', 'No space')
    } })
    const receipt = scheduler.persist(1)
    const flush = scheduler.flush()
    await expect(receipt).rejects.toThrow('No space')
    await expect(flush).rejects.toThrow('No space')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(calls).toBe(1)
    expect(scheduler.getSnapshot()).toMatchObject({ status: 'error', pendingCount: 1, error: { code: 'storage_full', message: 'No space' } })
    await scheduler.persist(1)
    await scheduler.flush()
    expect(calls).toBe(2)
    expect(scheduler.getSnapshot()).toMatchObject({ status: 'saved', pendingCount: 0, error: null })
    scheduler.dispose()
  })

  it('accepts a new write from a receipt continuation before the previous drain settles', async () => {
    const writes: number[] = []
    const scheduler = createOfficePersistenceScheduler({ policy, write: async (value: number) => { writes.push(value) } })
    await scheduler.persist(1).then(() => scheduler.persist(2))
    await scheduler.flush()
    expect(writes).toEqual([1, 2])
    scheduler.dispose()
  })

  it('settles a new latest write queued by the failed receipt continuation', async () => {
    const writes: number[] = []
    const scheduler = createOfficePersistenceScheduler({ policy, write: async (value: number) => {
      writes.push(value)
      if (value === 1) throw new Error('Storage interrupted')
    } })
    await scheduler.persist(1).catch(() => scheduler.persist(2))
    await scheduler.flush()
    expect(writes).toEqual([1, 1, 2])
    expect(scheduler.getSnapshot()).toMatchObject({ status: 'saved', pendingCount: 0 })
    scheduler.dispose()
  })

  it('acknowledges an imported baseline without encoding or writing it again', async () => {
    const writes: string[] = []
    const scheduler = createOfficePersistenceScheduler({ policy, key: String, write: async (value: string) => { writes.push(value) } })
    scheduler.acknowledge('imported')
    await scheduler.persist('imported')
    scheduler.schedule('imported')
    await scheduler.flush()
    expect(writes).toEqual([])
    await scheduler.persist('edited')
    expect(writes).toEqual(['edited'])
    scheduler.dispose()
  })

  it('does not make an older receipt completion replace a newer imported baseline', async () => {
    const started = deferred()
    const gate = deferred()
    const writes: string[] = []
    const scheduler = createOfficePersistenceScheduler({ policy, key: String, write: async (value: string) => {
      writes.push(value); started.resolve(); await gate.promise
    } })
    const receipt = scheduler.persist('previous')
    await started.promise
    scheduler.acknowledge('imported')
    gate.resolve()
    await receipt
    await scheduler.flush()
    await scheduler.persist('imported')
    expect(writes).toEqual(['previous'])
    scheduler.dispose()
  })

  it('drains work accepted before disposal and suppresses further subscriptions and scheduling', async () => {
    const gate = deferred()
    const written: number[] = []
    const observed: string[] = []
    const scheduler = createOfficePersistenceScheduler({ policy, write: async (value: number) => {
      await gate.promise; written.push(value)
    } })
    scheduler.subscribe((state) => observed.push(state.status))
    scheduler.schedule(1)
    expect(observed).toEqual(['pending'])
    scheduler.dispose()
    expect(scheduler.schedule(2)).toBe(false)
    await expect(scheduler.persist(2)).rejects.toThrow('closed')
    gate.resolve()
    await scheduler.flush()
    expect(written).toEqual([1])
    expect(observed).toEqual(['pending'])
    expect(scheduler.getSnapshot()).toMatchObject({ status: 'disposed', pendingCount: 0 })
  })

  it('keeps independent Session storage channels from waiting on each other', async () => {
    const gate = deferred()
    const first = createOfficePersistenceScheduler({ policy, write: async (_value: number) => gate.promise })
    const second = createOfficePersistenceScheduler({ policy: { ...policy, sessionId: 'session-b' }, write: async (_value: number) => undefined })
    const pending = first.persist(1)
    await second.persist(2)
    expect(second.getSnapshot().policy.sessionId).toBe('session-b')
    expect(first.getSnapshot().status).toBe('saving')
    gate.resolve()
    await pending
    first.dispose(); second.dispose()
  })
})

describe('Office persistence outcomes', () => {
  it('distinguishes an empty recovery store from an unreadable record', async () => {
    expect(await loadOfficeRecovery(async () => null)).toEqual({ status: 'empty' })
    expect(await loadOfficeRecovery(async () => ({ text: 'Restored' }))).toEqual({ status: 'restored', value: { text: 'Restored' } })
    expect(await loadOfficeRecovery(async () => { throw new OfficePersistenceError('invalid_recovery', 'Unreadable record') }))
      .toEqual({ status: 'failed', error: { code: 'invalid_recovery', message: 'Unreadable record' } })
  })

  it('preserves cancellation and conflict without treating them as successful saves', async () => {
    expect(await runOfficePersistenceOperation(async () => ({ status: 'canceled' }))).toEqual({ status: 'canceled' })
    expect(await runOfficePersistenceOperation(async () => ({ status: 'conflict', message: 'File changed' })))
      .toEqual({ status: 'conflict', message: 'File changed' })
    expect(await runOfficePersistenceOperation(async () => ({ status: 'written', value: 42 }))).toEqual({ status: 'written', value: 42 })
    expect(await runOfficePersistenceOperation(async () => { throw new Error('Write failed') }))
      .toEqual({ status: 'failed', error: { code: 'persistence_failed', message: 'Write failed' } })
  })
})
