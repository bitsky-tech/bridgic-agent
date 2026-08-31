/**
 * Pure local-resource parsing and Markdown rewriting for chat messages.
 *
 * A `file:` URL cannot be loaded by an http(s) Electron renderer while webSecurity stays on.
 * Main owns a read-only `bridgic-local:` protocol, and preload injects a per-launch token into
 * the trusted top frame. This module is the renderer half of that boundary: local image/media
 * elements use the internal URL while file links keep their original OS path and still go through
 * FileLink/openPath.
 *
 * Bare paths are recognised only in Agent Markdown output, and only when they occupy a complete
 * line, so that a path the Agent reports becomes useful without turning paths embedded in prose,
 * logs, or code into surprising UI. Fenced and indented code are excluded before Markdown is parsed
 * (which also preserves UNC backslashes that Markdown would otherwise consume as escapes).
 *
 * User input is never scanned: it renders verbatim. A path may contain spaces, so a line such as
 * `/tmp/a.docx make a deck from this` has no decidable boundary — the whole line parsed as one path
 * and swallowed the request into the link target.
 */
import { createLocalResourceUrl } from '@shared/local-resource'
import type { FileOpenTarget } from '@/atoms/fileOpen'
import { fileUrlToTarget } from './fileUrl'

export type LocalResourceKind = 'image' | 'video' | 'audio' | 'file'

export interface LocalResourceReference {
  /** Canonical file URL passed to the internal protocol. */
  fileUrl: string
  /** Decoded platform path used by FileLink/openPath and failure fallback. */
  target: FileOpenTarget
  kind: LocalResourceKind
}

export const LOCAL_RESOURCE_PREVIEW_TITLE = 'bridgic-local-preview'

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
])
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'ogv', 'webm'])
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav'])

/** Classify by extension; Chromium remains authoritative and an unsupported codec falls back to FileLink. */
export function localResourceKind(path: string): LocalResourceKind {
  const basename = path.split(/[\\/]/).pop() ?? ''
  const dot = basename.lastIndexOf('.')
  const extension = dot >= 0 ? basename.slice(dot + 1).toLowerCase() : ''
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  return 'file'
}

/** Encode path segments without encoding slash separators or a Windows drive's colon. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment, index) => {
      const encoded = encodeURIComponent(segment)
      return index === 0 && /^[a-zA-Z]:$/.test(segment) ? encoded.replace('%3A', ':') : encoded
    })
    .join('/')
}

/** Convert an absolute POSIX, drive-letter, or UNC path to a canonical file URL. */
export function absolutePathToFileUrl(path: string): string | null {
  if (path.includes('\0') || path.includes('\n') || path.includes('\r')) return null

  try {
    // Windows UNC. Require both a server and a share/path component so a Markdown
    // line beginning with two slashes is not accidentally treated as a resource.
    if (/^(?:\\\\|\/\/)[^\\/\s]+[\\/][^\r\n]+$/.test(path)) {
      const normalized = path.replaceAll('\\', '/').replace(/^\/\//, '')
      const slash = normalized.indexOf('/')
      const host = normalized.slice(0, slash)
      const rest = normalized.slice(slash + 1)
      return `file://${encodeURIComponent(host)}/${encodePath(rest)}`
    }

    // Windows drive path. Both separators occur in model output in practice.
    if (/^[a-zA-Z]:[\\/]/.test(path)) {
      return `file:///${encodePath(path.replaceAll('\\', '/'))}`
    }

    if (path.startsWith('/') && !path.startsWith('//')) {
      return `file://${encodePath(path)}`
    }
  } catch {
    // encodeURIComponent rejects malformed UTF-16 (for example a lone surrogate).
    // Treat such input as ordinary text instead of breaking the message render.
    return null
  }
  return null
}

/** Parse a complete local-resource reference, including root-level files and directories. */
export function parseLocalResourceReference(value: string): LocalResourceReference | null {
  const source = value.trim()
  if (!source) return null
  // `/help` is the one built-in command that can deliberately be demoted to a
  // plain text block when it is unavailable in the current mode. Keep that
  // existing command text stable instead of interpreting it as a root path.
  if (source === '/help') return null

  let fileUrl = ''
  try {
    const url = new URL(source)
    // Accept every standards-valid spelling (`file:///tmp/a`, `file:/tmp/a`, UNC host form),
    // not only the common triple-slash spelling.
    if (url.protocol === 'file:') {
      fileUrl = url.href
    }
  } catch {
    // A plain OS path is intentionally not a URL; parse it below.
  }
  if (!fileUrl) {
    fileUrl = absolutePathToFileUrl(source) ?? ''
    if (!fileUrl) return null
  }

  const target = fileUrlToTarget(fileUrl)
  if (!target) return null
  return { fileUrl, target, kind: localResourceKind(target.path) }
}

/** Read the launch token without making pure helpers depend on Electron globals in tests/browser preview. */
function injectedLocalResourceToken(): string | null {
  if (typeof window === 'undefined') return null
  const token = (window as Window & { __localResourceToken__?: unknown }).__localResourceToken__
  return typeof token === 'string' && token ? token : null
}

/**
 * Turn file URL into the internal display URL. Missing token is an intentional graceful fallback:
 * browser-only previews and unit tests keep seeing the original `file:` value, while production's
 * trusted Electron frame always receives the token from preload.
 */
export function toLocalResourceDisplayUrl(
  fileUrl: string,
  token: string | null = injectedLocalResourceToken(),
): string {
  if (!token) return fileUrl
  try {
    return createLocalResourceUrl(fileUrl, token)
  } catch {
    return fileUrl
  }
}

function escapeMarkdownLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replace(/([\[\]])/g, '\\$1')
}

function rewriteReferenceLine(reference: LocalResourceReference): string {
  const label = escapeMarkdownLabel(reference.target.name)
  // Images use native Markdown image syntax and flow through the custom img renderer. Audio/video
  // use a title sentinel so an explicitly authored ordinary file link remains an ordinary FileLink.
  if (reference.kind === 'image') return `![${label}](<${reference.fileUrl}>)`
  if (reference.kind === 'video' || reference.kind === 'audio') {
    return `[${label}](<${reference.fileUrl}> "${LOCAL_RESOURCE_PREVIEW_TITLE}")`
  }
  return `[${label}](<${reference.fileUrl}>)`
}

interface MarkdownFence {
  marker: '`' | '~'
  length: number
}

function openingFence(line: string): MarkdownFence | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line)
  if (!match) return null
  const sequence = match[1]!
  return { marker: sequence[0] as '`' | '~', length: sequence.length }
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  // CommonMark closing fences may only contain indentation, the marker run, and whitespace.
  // A line such as ```not-a-close is code content, not a closing fence.
  const match = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line)
  if (!match) return false
  const sequence = match[1]!
  return sequence[0] === fence.marker && sequence.length >= fence.length
}

/** Rewrite complete bare-path lines to safe Markdown links/media, skipping fenced and indented code. */
export function rewriteBareLocalPaths(markdown: string): string {
  let fence: MarkdownFence | null = null

  return markdown
    .split(/(\r?\n)/)
    .map((line) => {
      if (/^\r?\n$/.test(line)) return line

      if (fence !== null) {
        if (closesFence(line, fence)) fence = null
        return line
      }
      const opening = openingFence(line)
      if (opening) {
        fence = opening
        return line
      }
      if (/^(?: {4}|\t)/.test(line)) return line

      const leading = line.match(/^ {0,3}/)?.[0] ?? ''
      const candidate = line.slice(leading.length).trimEnd()
      const reference = parseLocalResourceReference(candidate)
      if (!reference) return line
      return `${leading}${rewriteReferenceLine(reference)}`
    })
    .join('')
}
