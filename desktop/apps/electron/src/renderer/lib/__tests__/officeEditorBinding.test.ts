import { describe, expect, it } from 'bun:test'
import { createOfficeEditorBinding, type OfficeEditorLease } from '../office/officeEditorBinding'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Office editor binding', () => {
  it('reports readiness and reads the driver authority without retaining a copy', async () => {
    let value = { text: 'initial' }
    const binding = createOfficeEditorBinding<typeof value>({ appKind: 'word', sessionId: 's', documentId: 'a' })
    expect(binding.getStatus()).toBe('loading')
    expect(binding.readSnapshot()).toBeNull()
    await expect(binding.flush()).rejects.toMatchObject({ code: 'editor_not_ready' })
    binding.attach({ readSnapshot: () => value, flush() {}, dispose() {} })
    expect(binding.getStatus()).toBe('ready')
    expect(binding.readSnapshot()).toBe(value)
    value = { text: 'native edit' }
    expect(binding.readSnapshot()).toBe(value)
  })

  it('publishes native input synchronously with its immutable Session and document identity', () => {
    const events: unknown[] = []
    const binding = createOfficeEditorBinding<string>({
      appKind: 'excel', sessionId: 's', documentId: 'a',
      onChange: (value, identity) => events.push({ value, identity }),
    })
    binding.attach({ readSnapshot: () => 'one', flush() {}, dispose() {} })
    expect(binding.publishChange('typed')).toBe(true)
    expect(events).toEqual([{ value: 'typed', identity: { appKind: 'excel', sessionId: 's', documentId: 'a' } }])
    expect(Object.isFrozen(binding.capture().identity)).toBe(true)
  })

  it('invalidates old callbacks when a reusable engine switches away and back', () => {
    let changes = 0
    let disposals = 0
    const binding = createOfficeEditorBinding<string>({ appKind: 'presentation', sessionId: 's', documentId: 'a', onChange: () => { changes += 1 } })
    binding.attach({ readSnapshot: () => 'model', flush() {}, dispose() { disposals += 1 } })
    const original = binding.capture()
    expect(binding.bindDocument('a')).toBe(original)
    binding.bindDocument('b')
    binding.bindDocument('a')
    expect(original.isCurrent()).toBe(false)
    expect(() => original.assertCurrent()).toThrow('The active Office document changed.')
    expect(binding.publishChange('late', original)).toBe(false)
    expect(binding.publishChange('current')).toBe(true)
    expect(changes).toBe(1)
    expect(disposals).toBe(0)
  })

  it('does not accept a lease from another engine even with identical public identity', () => {
    const options = { appKind: 'word' as const, sessionId: 's', documentId: 'a' }
    const first = createOfficeEditorBinding<string>(options)
    const second = createOfficeEditorBinding<string>(options)
    first.attach({ readSnapshot: () => '', flush() {}, dispose() {} })
    second.attach({ readSnapshot: () => '', flush() {}, dispose() {} })
    expect(first.publishChange('foreign', second.capture())).toBe(false)
  })

  it('waits for native synchronization and rejects a result after document replacement', async () => {
    const gate = deferred()
    let lease!: OfficeEditorLease
    const binding = createOfficeEditorBinding<string>({ appKind: 'word', sessionId: 's', documentId: 'a' })
    binding.attach({ readSnapshot: () => '', flush: (captured) => { lease = captured; return gate.promise }, dispose() {} })
    let settled = false
    const flushing = binding.flush().finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    binding.bindDocument('b')
    expect(lease.isCurrent()).toBe(false)
    gate.resolve()
    await expect(flushing).rejects.toMatchObject({ code: 'editor_changed' })
  })

  it('allows retry after a failed native flush', async () => {
    let attempts = 0
    const binding = createOfficeEditorBinding<string>({ appKind: 'excel', sessionId: 's', documentId: 'a' })
    binding.attach({ readSnapshot: () => '', flush() { if (++attempts === 1) throw new Error('native failure') }, dispose() {} })
    await expect(binding.flush()).rejects.toThrow('native failure')
    await binding.flush()
    expect(attempts).toBe(2)
  })

  it('invalidates callbacks before cleanup and disposes its driver exactly once', async () => {
    let disposals = 0
    let cleanupPublished: boolean | undefined
    const binding = createOfficeEditorBinding<string>({ appKind: 'word', sessionId: 's', documentId: 'a' })
    const lease = binding.capture()
    binding.attach({
      readSnapshot: () => '', flush() {},
      dispose() { disposals += 1; cleanupPublished = binding.publishChange('late', lease) },
    })
    binding.dispose()
    binding.dispose()
    expect(disposals).toBe(1)
    expect(cleanupPublished).toBe(false)
    expect(lease.isCurrent()).toBe(false)
    expect(binding.getStatus()).toBe('disposed')
    expect(binding.readSnapshot()).toBeNull()
    await expect(binding.flush()).rejects.toMatchObject({ code: 'editor_disposed' })
  })

  it('releases an asynchronously created driver that arrives after unmount', () => {
    let disposals = 0
    const binding = createOfficeEditorBinding<string>({ appKind: 'presentation', sessionId: 's', documentId: 'a' })
    binding.dispose()
    expect(binding.attach({ readSnapshot: () => '', flush() {}, dispose() { disposals += 1 } })).toBe(false)
    expect(disposals).toBe(1)
    expect(binding.getStatus()).toBe('disposed')
  })

  it('rejects a pending flush after unmount without reporting a successful checkpoint', async () => {
    const gate = deferred()
    const binding = createOfficeEditorBinding<string>({ appKind: 'word', sessionId: 's', documentId: 'a' })
    binding.attach({ readSnapshot: () => '', flush: () => gate.promise, dispose() {} })
    const flushing = binding.flush()
    binding.dispose()
    gate.resolve()
    await expect(flushing).rejects.toMatchObject({ code: 'editor_disposed' })
  })

  it('cleans up a duplicate mount while preserving the current driver', () => {
    let currentDisposed = false
    let duplicateDisposed = false
    const binding = createOfficeEditorBinding<string>({ appKind: 'excel', sessionId: 's', documentId: null })
    const current = { readSnapshot: () => 'current', flush() {}, dispose() { currentDisposed = true } }
    binding.attach(current)
    expect(binding.attach(current)).toBe(true)
    expect(() => binding.attach({ readSnapshot: () => 'duplicate', flush() {}, dispose() { duplicateDisposed = true } })).toThrow('An Office editor is already attached')
    expect(duplicateDisposed).toBe(true)
    expect(currentDisposed).toBe(false)
    expect(binding.readSnapshot()).toBe('current')
  })
})
