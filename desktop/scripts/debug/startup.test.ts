import { afterEach, describe, expect, it } from 'bun:test'
import desktopViteConfig from '../../apps/electron/vite.config'
import { clearDebugStartupEnvironment, debugViteSettings, isDebugStartup } from './startup'

const originalToken = process.env.DESKTOP_DEBUG_STARTUP_TOKEN
const originalUrl = process.env.DESKTOP_DEBUG_API_URL
afterEach(() => {
  if (originalToken === undefined) delete process.env.DESKTOP_DEBUG_STARTUP_TOKEN
  else process.env.DESKTOP_DEBUG_STARTUP_TOKEN = originalToken
  if (originalUrl === undefined) delete process.env.DESKTOP_DEBUG_API_URL
  else process.env.DESKTOP_DEBUG_API_URL = originalUrl
})

describe('Desktop debug startup gate', () => {
  const environment = { DESKTOP_DEBUG_STARTUP_TOKEN: 'b'.repeat(64), DESKTOP_DEBUG_API_URL: 'http://127.0.0.1:45678' }

  it('requires explicit debug startup and lets ordinary dev force normal mode', () => {
    expect(isDebugStartup([])).toBe(false)
    expect(isDebugStartup(['--debug'])).toBe(true)
    expect(isDebugStartup(['--normal', '--debug'])).toBe(false)
    const inherited: Record<string, string | undefined> = { ...environment, APP_VITE_PORT: '5173' }
    clearDebugStartupEnvironment(inherited)
    expect(inherited).toEqual({ APP_VITE_PORT: '5173' })
    expect(debugViteSettings('serve', inherited).enabled).toBe(false)
  })

  it('rejects incomplete startup state and non-loopback API endpoints', () => {
    expect(debugViteSettings('serve', environment).enabled).toBe(true)
    expect(debugViteSettings('serve', { DESKTOP_DEBUG_STARTUP_TOKEN: environment.DESKTOP_DEBUG_STARTUP_TOKEN }).enabled).toBe(false)
    for (const target of ['https://127.0.0.1:45678', 'http://example.com:45678', 'http://user@127.0.0.1:45678', 'http://127.0.0.1:45678/path']) {
      expect(debugViteSettings('serve', { ...environment, DESKTOP_DEBUG_API_URL: target }).enabled).toBe(false)
    }
  })

  it('forces production Vite builds normal even when all debug environment variables are inherited', async () => {
    Object.assign(process.env, environment)
    if (typeof desktopViteConfig !== 'function') throw new Error('Expected a command-aware Vite config')
    const built = await desktopViteConfig({ command: 'build', mode: 'production', isPreview: false })
    expect(built.define?.__DESKTOP_DEBUG__).toBe('false')
    expect(built.server?.proxy).toBeUndefined()
    const served = await desktopViteConfig({ command: 'serve', mode: 'development', isPreview: false })
    expect(served.define?.__DESKTOP_DEBUG__).toBe('true')
    expect(served.server?.proxy?.['/__debug-api']).toMatchObject({
      target: environment.DESKTOP_DEBUG_API_URL,
      headers: { authorization: `Bearer ${environment.DESKTOP_DEBUG_STARTUP_TOKEN}` },
    })
  })
})
