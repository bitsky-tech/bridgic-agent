import { describe, expect, it } from 'bun:test'
import { parseExternalUrl, redactExternalUrlLogArgs } from '../external-url'

describe('external URL handling', () => {
  it('accepts browser-safe schemes and rejects launcher schemes', () => {
    expect(parseExternalUrl('https://github.com/org/repo').protocol).toBe('https:')
    expect(parseExternalUrl('mailto:support@example.com').protocol).toBe('mailto:')
    expect(() => parseExternalUrl('file:///tmp/private.txt')).toThrow('scheme file:')
    expect(() => parseExternalUrl('javascript:alert(1)')).toThrow('scheme javascript:')
  })

  it('never includes an invalid raw URL in its error', () => {
    const raw = 'not-a-url-with-private-report-text'
    try {
      parseExternalUrl(raw)
      throw new Error('expected parse failure')
    } catch (error) {
      expect(String(error)).not.toContain(raw)
      expect(String(error)).toContain('Invalid external URL')
    }
  })

  it('redacts query, fragment, and credentials while keeping the destination useful', () => {
    const logged = redactExternalUrlLogArgs([
      'https://user:password@github.com/org/repo/issues/new?body=private-context#private-fragment',
    ])
    expect(logged).toEqual([
      'https://github.com/org/repo/issues/new?[redacted]#[redacted]',
    ])
    expect(JSON.stringify(logged)).not.toContain('private-context')
    expect(JSON.stringify(logged)).not.toContain('password')
  })

  it('redacts mail recipients and malformed values', () => {
    expect(redactExternalUrlLogArgs(['mailto:private@example.com?body=secret']))
      .toEqual(['mailto:[redacted]'])
    expect(redactExternalUrlLogArgs(['not a url'])).toEqual(['[invalid external URL]'])
  })
})
