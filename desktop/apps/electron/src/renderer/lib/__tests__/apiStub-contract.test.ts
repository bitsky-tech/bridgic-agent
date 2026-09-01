/**
 * `apiStub` must implement **every** IPC method in `ElectronAPI`.
 *
 * Why this deserves a test: adding IPC requires four coordinated edits (channels -> types ->
 * preload -> apiStub), and apiStub is the only omission typecheck cannot catch. It is a
 * hand-written, Partial-like object, so a missing method stays silent until Playwright, which
 * has no preload and must use the stub, fails at runtime with `undefined is not a function`.
 *
 * Assert that the stub covers the same keys exposed by preload instead of hard-coding a method
 * list. A hard-coded list would require manual synchronization and recreate the same omission risk.
 */
import { describe, it, expect } from 'bun:test'

import { IPC } from '@shared/ipc-channels'

describe('apiStub IPC contract', () => {
  it('stubs every native-window channel declared in IPC', async () => {
    const fakeWindow: { api?: { window: Record<string, unknown> } } = {}
    ;(globalThis as { window?: unknown }).window = fakeWindow
    const { installApiStub } = await import('../apiStub')
    installApiStub()

    const declared = Object.keys(IPC.window).sort()
    const stubbed = Object.keys(fakeWindow.api?.window ?? {}).sort()

    expect(stubbed).toEqual(declared)
    for (const name of declared) {
      expect(typeof fakeWindow.api?.window[name]).toBe('function')
    }
  })

  it('stubs every backend channel declared in IPC', async () => {
    // installApiStub installs the fallback on window.api outside Electron, so create an empty
    // window first. Use a dynamic import because the module reads window at module scope.
    const fakeWindow: { api?: { backend: Record<string, unknown> } } = {}
    ;(globalThis as { window?: unknown }).window = fakeWindow
    const { installApiStub } = await import('../apiStub')
    installApiStub()

    const declared = Object.keys(IPC.backend).sort()
    const stubbed = Object.keys(fakeWindow.api?.backend ?? {}).sort()

    expect(stubbed).toEqual(declared)
    for (const name of declared) {
      expect(typeof fakeWindow.api?.backend[name]).toBe('function')
    }
  })

  it('stubs every embedded-browser channel declared in IPC', async () => {
    const fakeWindow: { api?: { browser: Record<string, unknown> } } = {}
    ;(globalThis as { window?: unknown }).window = fakeWindow
    const { installApiStub } = await import('../apiStub')
    installApiStub()

    const declared = Object.keys(IPC.browser).sort()
    const stubbed = Object.keys(fakeWindow.api?.browser ?? {}).sort()

    expect(stubbed).toEqual(declared)
    for (const name of declared) {
      expect(typeof fakeWindow.api?.browser[name]).toBe('function')
    }
  })

  it('stubs every embedded-PowerPoint channel declared in IPC', async () => {
    const fakeWindow: { api?: { powerpoint: Record<string, unknown> } } = {}
    ;(globalThis as { window?: unknown }).window = fakeWindow
    const { installApiStub } = await import('../apiStub')
    installApiStub()

    const declared = Object.keys(IPC.powerpoint).sort()
    const stubbed = Object.keys(fakeWindow.api?.powerpoint ?? {}).sort()

    expect(stubbed).toEqual(declared)
    for (const name of declared) {
      expect(typeof fakeWindow.api?.powerpoint[name]).toBe('function')
    }
  })

  it('stubs every system channel and returns only allow-listed diagnostics', async () => {
    const fakeWindow: {
      api?: { system: Record<string, (...args: never[]) => Promise<unknown>> }
    } = {}
    ;(globalThis as { window?: unknown }).window = fakeWindow
    const { installApiStub } = await import('../apiStub')
    installApiStub()

    const declared = Object.keys(IPC.system).sort()
    const stubbed = Object.keys(fakeWindow.api?.system ?? {}).sort()
    expect(stubbed).toEqual(declared)

    const getDiagnostics = fakeWindow.api?.system.getDiagnostics
    expect(typeof getDiagnostics).toBe('function')
    if (!getDiagnostics) throw new Error('system.getDiagnostics stub is missing')
    const diagnostics = await getDiagnostics() as Record<string, unknown>
    expect(Object.keys(diagnostics).sort()).toEqual([
      'appVersion',
      'arch',
      'chromeVersion',
      'electronVersion',
      'osRelease',
      'platform',
    ].sort())
  })

  it('stubs every issue-report channel', async () => {
    const fakeWindow: { api?: { issueReport: Record<string, unknown> } } = {}
    ;(globalThis as { window?: unknown }).window = fakeWindow
    const { installApiStub } = await import('../apiStub')
    installApiStub()

    const declared = Object.keys(IPC.issueReport).sort()
    const stubbed = Object.keys(fakeWindow.api?.issueReport ?? {}).sort()

    expect(stubbed).toEqual(declared)
    for (const name of declared) {
      expect(typeof fakeWindow.api?.issueReport[name]).toBe('function')
    }
  })

  it('stubs every filesystem channel', async () => {
    const fakeWindow: { api?: { fs: Record<string, unknown> } } = {}
    ;(globalThis as { window?: unknown }).window = fakeWindow
    const { installApiStub } = await import('../apiStub')
    installApiStub()

    const declared = Object.keys(IPC.fs).sort()
    const stubbed = Object.keys(fakeWindow.api?.fs ?? {}).sort()

    expect(stubbed).toEqual(declared)
    for (const name of declared) {
      expect(typeof fakeWindow.api?.fs[name]).toBe('function')
    }
  })
})
