/**
 * `apiStub` 必须实现 `ElectronAPI` 的**全部** IPC 方法。
 *
 * 为什么值得单测:新增 IPC 要同时改 4 个点位(channels → types → preload →
 * apiStub),而 apiStub 是唯一**不会**被 typecheck 抓住漏改的那个 —— 它是
 * `Partial`-ish 的手写对象,少一个方法在编译期无声无息,直到 Playwright(没有
 * preload,只能用 stub)在运行时炸 `undefined is not a function`。
 *
 * 断言的是"stub 覆盖了 preload 暴露的同一组 key",而不是硬编码一份方法名清单
 * —— 后者每加一个方法就要手工同步,和它想防的漏改是同一类问题。
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
    // installApiStub 把 stub 装到 window.api 上(非 Electron 上下文的兜底),
    // 所以要先造一个空 window 再装。动态 import:模块级读 window。
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
