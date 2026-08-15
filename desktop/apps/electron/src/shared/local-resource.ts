/**
 * Internal, renderer-visible contract for read-only local resources.
 *
 * The startup token is deliberately part of every URL. It prevents an
 * untrusted child frame sharing the main Electron session from constructing a
 * working local-resource URL on its own. The preload exposes that token only
 * in the trusted main frame.
 */
export const LOCAL_RESOURCE_SCHEME = 'bridgic-local'
export const LOCAL_RESOURCE_HOST = 'file'
export const LOCAL_RESOURCE_TOKEN_ARGUMENT_PREFIX = '--local-resource-token='

/** Build the internal URL used by image/media elements for a local file URL. */
export function createLocalResourceUrl(source: string, token: string): string {
  if (!token) throw new Error('Local-resource token is required')

  let sourceUrl: URL
  try {
    sourceUrl = new URL(source)
  } catch {
    throw new Error('Local resource must be a valid file URL')
  }
  if (sourceUrl.protocol !== 'file:') {
    throw new Error('Local resource must use the file: scheme')
  }

  const internalUrl = new URL(`${LOCAL_RESOURCE_SCHEME}://${LOCAL_RESOURCE_HOST}`)
  internalUrl.searchParams.set('src', sourceUrl.href)
  internalUrl.searchParams.set('token', token)
  return internalUrl.href
}

/** Read the startup token injected through BrowserWindow.additionalArguments. */
export function localResourceTokenFromArgv(argv: readonly string[]): string | null {
  const argument = argv.find((value) => value.startsWith(LOCAL_RESOURCE_TOKEN_ARGUMENT_PREFIX))
  const token = argument?.slice(LOCAL_RESOURCE_TOKEN_ARGUMENT_PREFIX.length) ?? ''
  return token || null
}
