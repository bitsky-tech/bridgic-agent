import { describe, expect, it } from 'bun:test'
import {
  absolutePathToFileUrl,
  localResourceKind,
  parseLocalResourceReference,
  rewriteBareLocalPaths,
  toLocalResourceDisplayUrl,
} from '../localResource'

describe('local resource path parsing', () => {
  it('converts POSIX, drive-letter and UNC paths to encoded file URLs', () => {
    expect(absolutePathToFileUrl('/Users/me/My QR #1.png')).toBe(
      'file:///Users/me/My%20QR%20%231.png',
    )
    expect(absolutePathToFileUrl('C:\\Users\\me\\My QR.png')).toBe(
      'file:///C:/Users/me/My%20QR.png',
    )
    expect(absolutePathToFileUrl('\\\\fileserver\\team\\My QR.png')).toBe(
      'file://fileserver/team/My%20QR.png',
    )
  })

  it('accepts every valid file URL spelling and rejects non-file URLs', () => {
    expect(parseLocalResourceReference('file:/tmp/a.png')).toMatchObject({
      fileUrl: 'file:///tmp/a.png',
      kind: 'image',
      target: { path: '/tmp/a.png', name: 'a.png' },
    })
    expect(parseLocalResourceReference('https://example.com/a.png')).toBeNull()
    expect(parseLocalResourceReference('relative/a.png')).toBeNull()
  })

  it('accepts root-level paths so local directories remain clickable', () => {
    expect(parseLocalResourceReference('/tmp')?.kind).toBe('file')
    expect(parseLocalResourceReference('/README.md')?.kind).toBe('file')
    expect(parseLocalResourceReference('/etc/hosts')?.kind).toBe('file')
  })

  it('preserves the built-in help command when it is demoted to plain text', () => {
    expect(parseLocalResourceReference('/help')).toBeNull()
  })

  it('rejects malformed UTF-16 paths without throwing during render', () => {
    expect(absolutePathToFileUrl('/tmp/\ud800.png')).toBeNull()
    expect(parseLocalResourceReference('/tmp/\ud800.png')).toBeNull()
  })

  it('classifies images and media without pretending every file is previewable', () => {
    expect(localResourceKind('/tmp/image.WEBP')).toBe('image')
    expect(localResourceKind('/tmp/clip.mp4')).toBe('video')
    expect(localResourceKind('/tmp/note.flac')).toBe('audio')
    expect(localResourceKind('/tmp/report.pdf')).toBe('file')
  })
})

describe('bare local paths in Markdown', () => {
  it('rewrites complete POSIX, Windows and UNC lines', () => {
    const rewritten = rewriteBareLocalPaths([
      '/tmp/qr code.png',
      '',
      'C:\\Users\\me\\demo.mp4',
      '',
      '\\\\server\\share\\report.pdf',
    ].join('\n'))

    expect(rewritten).toContain('![qr code.png](<file:///tmp/qr%20code.png>)')
    expect(rewritten).toContain(
      '[demo.mp4](<file:///C:/Users/me/demo.mp4> "bridgic-local-preview")',
    )
    expect(rewritten).toContain('[report.pdf](<file://server/share/report.pdf>)')
  })

  it('leaves prose, fenced code and indented code untouched', () => {
    const markdown = [
      '结果在 /tmp/result.png，请查看。',
      '',
      '```text',
      '/tmp/in-code.png',
      '```',
      '',
      '    /tmp/indented.png',
    ].join('\n')
    expect(rewriteBareLocalPaths(markdown)).toBe(markdown)
  })

  it('does not treat a marker with trailing content as a closing fence', () => {
    const markdown = [
      '```text',
      '```not-a-close',
      '/tmp/still-in-code.png',
      '```',
    ].join('\n')
    expect(rewriteBareLocalPaths(markdown)).toBe(markdown)
  })
})

describe('internal display URL', () => {
  it('adds source and launch token through the shared protocol contract', () => {
    const result = toLocalResourceDisplayUrl('file:///tmp/a%20b.png', 'launch-token')
    const url = new URL(result)
    expect(url.protocol).toBe('bridgic-local:')
    expect(url.hostname).toBe('file')
    expect(url.searchParams.get('src')).toBe('file:///tmp/a%20b.png')
    expect(url.searchParams.get('token')).toBe('launch-token')
  })

  it('keeps file URL as a graceful browser/test fallback without a token', () => {
    expect(toLocalResourceDisplayUrl('file:///tmp/a.png', null)).toBe('file:///tmp/a.png')
  })
})
