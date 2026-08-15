import { describe, expect, it } from 'bun:test'
import { redactLocalPathForLog, redactLocalPathLogArgs } from '../path-log'

describe('local path log redaction', () => {
  it('redacts every component of POSIX paths', () => {
    const logged = redactLocalPathLogArgs(['/Users/private-user/secret-folder/report.md'])

    expect(logged).toEqual(['[local path]'])
    expect(JSON.stringify(logged)).not.toContain('private-user')
    expect(JSON.stringify(logged)).not.toContain('secret-folder')
    expect(JSON.stringify(logged)).not.toContain('report.md')
  })

  it('redacts every component of Windows paths', () => {
    const logged = redactLocalPathLogArgs([
      String.raw`C:\Users\private-user\secret-folder\report.md`,
    ])

    expect(logged).toEqual(['[local path]'])
    expect(JSON.stringify(logged)).not.toContain('private-user')
    expect(JSON.stringify(logged)).not.toContain('secret-folder')
    expect(JSON.stringify(logged)).not.toContain('report.md')
  })

  it('handles directories with trailing separators and filesystem roots', () => {
    expect(redactLocalPathForLog('/Users/private-user/Downloads/')).toBe('[local path]')
    expect(redactLocalPathForLog('/')).toBe('[local path]')
    expect(redactLocalPathForLog('C:\\')).toBe('[local path]')
  })

  it('does not stringify invalid values', () => {
    expect(redactLocalPathLogArgs([undefined])).toEqual(['[invalid local path]'])
    expect(redactLocalPathLogArgs([{ path: '/private/secret' }])).toEqual([
      '[invalid local path]',
    ])
  })
})
