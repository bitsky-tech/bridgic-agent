import { describe, expect, it } from 'bun:test'
import { loadShellEnv } from '../shell-env'

describe('loadShellEnv', () => {
  it('is a no-op on non-darwin platforms', () => {
    if (process.platform === 'darwin') return // skip on the only platform where it acts
    const before = JSON.stringify(process.env)
    loadShellEnv()
    expect(JSON.stringify(process.env)).toEqual(before)
  })
})
