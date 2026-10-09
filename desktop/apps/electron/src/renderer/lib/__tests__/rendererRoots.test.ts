import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('standalone renderer roots', () => {
  it('gives every Office entry root the full viewport height', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')

    expect(css).toMatch(/html,\s*body,\s*#root,\s*#excel-root,\s*#word-root\s*\{[^}]*height:\s*100%/s)
  })
})
