import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  filesNeedsAttentionFamily,
  purgeFilesAttentionAtom,
  setFilesNeedsAttentionAtom,
} from '../files-attention'

describe('filesNeedsAttentionFamily', () => {
  it('marks and clears Files attention for one Session', () => {
    const store = createStore()

    expect(store.get(filesNeedsAttentionFamily('session-a'))).toBe(false)

    store.set(setFilesNeedsAttentionAtom, {
      sessionId: 'session-a',
      needsAttention: true,
    })
    expect(store.get(filesNeedsAttentionFamily('session-a'))).toBe(true)

    store.set(setFilesNeedsAttentionAtom, {
      sessionId: 'session-a',
      needsAttention: false,
    })
    expect(store.get(filesNeedsAttentionFamily('session-a'))).toBe(false)
  })

  it('isolates attention by Session and drops deleted Session state', () => {
    const store = createStore()
    store.set(setFilesNeedsAttentionAtom, {
      sessionId: 'session-a',
      needsAttention: true,
    })
    store.set(setFilesNeedsAttentionAtom, {
      sessionId: 'session-b',
      needsAttention: true,
    })

    store.set(purgeFilesAttentionAtom, 'session-a')

    expect(store.get(filesNeedsAttentionFamily('session-a'))).toBe(false)
    expect(store.get(filesNeedsAttentionFamily('session-b'))).toBe(true)
  })

  it('ignores updates without a Session id', () => {
    const store = createStore()

    store.set(setFilesNeedsAttentionAtom, {
      sessionId: '',
      needsAttention: true,
    })

    expect(store.get(filesNeedsAttentionFamily(''))).toBe(false)
  })
})
