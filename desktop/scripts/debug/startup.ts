export const DEBUG_STARTUP_TOKEN_ENV = 'DESKTOP_DEBUG_STARTUP_TOKEN'
export const DEBUG_API_URL_ENV = 'DESKTOP_DEBUG_API_URL'

/** --normal wins even when a caller appends --debug to `bun run dev`. */
export function isDebugStartup(args: readonly string[]): boolean {
  return args.includes('--debug') && !args.includes('--normal')
}

/** Environment alone cannot switch the ordinary Desktop launcher to debug. */
export function clearDebugStartupEnvironment(env: Record<string, string | undefined>): void {
  delete env[DEBUG_STARTUP_TOKEN_ENV]
  delete env[DEBUG_API_URL_ENV]
}

/** Shared with Vite's Node config; deliberately has no Bun/server imports. */
export function debugViteSettings(command: string, env: Record<string, string | undefined>) {
  const token = env[DEBUG_STARTUP_TOKEN_ENV]
  const endpoint = env[DEBUG_API_URL_ENV]
  if (command !== 'serve' || !token || !/^[a-f0-9]{64}$/.test(token) || !endpoint) {
    return { enabled: false as const }
  }
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return { enabled: false as const }
    }
    return { enabled: true as const, target: url.origin, token }
  } catch {
    return { enabled: false as const }
  }
}
