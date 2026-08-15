import { describe, expect, it, mock } from 'bun:test'
import { runPrimaryInstanceBootstrap } from '../single-instance-bootstrap'

describe('runPrimaryInstanceBootstrap', () => {
  it('does not invoke bootstrap when the single-instance lock is denied', () => {
    const bootstrap = mock(() => {})

    expect(runPrimaryInstanceBootstrap(false, bootstrap)).toBe(false)
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it('invokes bootstrap exactly once for the lock owner', () => {
    const bootstrap = mock(() => {})

    expect(runPrimaryInstanceBootstrap(true, bootstrap)).toBe(true)
    expect(bootstrap).toHaveBeenCalledTimes(1)
  })
})
