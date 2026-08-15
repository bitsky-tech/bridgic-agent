const ALLOWED_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

export function parseExternalUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid external URL')
  }
  if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Refusing to open external URL with scheme ${parsed.protocol}`)
  }
  return parsed
}

/** Keep the useful destination in logs without persisting query or fragment contents. */
export function redactExternalUrlForLog(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') return '[invalid external URL]'
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return '[invalid external URL]'
  }
  if (parsed.protocol === 'mailto:') return 'mailto:[redacted]'
  const query = parsed.search ? '?[redacted]' : ''
  const fragment = parsed.hash ? '#[redacted]' : ''
  return `${parsed.origin}${parsed.pathname}${query}${fragment}`
}

export function redactExternalUrlLogArgs(args: readonly unknown[]): unknown {
  return [redactExternalUrlForLog(args[0])]
}
