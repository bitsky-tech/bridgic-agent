import { describe, expect, it } from 'bun:test'
import { GUI_BACKGROUND_ARG } from '../../shared/app-meta'
import {
  classifySecondInstance,
  parseLaunchIntent,
  shouldStartBackendForLaunch,
} from '../launch-intent'

const scheme = 'amphi'

describe('parseLaunchIntent', () => {
  it('keeps an ordinary launch in the foreground', () => {
    expect(parseLaunchIntent(['Amphi.exe'], scheme)).toEqual({
      background: false,
      deepLinkUrl: null,
    })
  })

  it('accepts the canonical background switch and legacy hidden alias', () => {
    expect(parseLaunchIntent(['Amphi.exe', GUI_BACKGROUND_ARG], scheme).background).toBe(true)
    expect(parseLaunchIntent(['Amphi.exe', '--hidden'], scheme).background).toBe(true)
  })

  it('does not mistake similarly named arguments for a background launch', () => {
    expect(parseLaunchIntent(['Amphi.exe', '--background-worker'], scheme).background).toBe(false)
    expect(parseLaunchIntent(['Amphi.exe', '--hidden=true'], scheme).background).toBe(false)
  })

  it('lets a deep link override either background spelling', () => {
    const url = 'amphi://task/123'

    expect(parseLaunchIntent(['Amphi.exe', GUI_BACKGROUND_ARG, url], scheme)).toEqual({
      background: false,
      deepLinkUrl: url,
    })
    expect(parseLaunchIntent(['Amphi.exe', '--hidden', url], scheme)).toEqual({
      background: false,
      deepLinkUrl: url,
    })
  })

  it('treats a packaged macOS login launch as background without an argv flag', () => {
    expect(parseLaunchIntent(['Amphi'], scheme, { wasOpenedAtLogin: true })).toEqual({
      background: true,
      deepLinkUrl: null,
    })
  })

  it('lets a deep link override the packaged macOS login signal', () => {
    const url = 'amphi://task/login-deep-link'

    expect(parseLaunchIntent(['Amphi', url], scheme, { wasOpenedAtLogin: true })).toEqual({
      background: false,
      deepLinkUrl: url,
    })
  })
})

describe('classifySecondInstance', () => {
  it('ignores only a pure background duplicate', () => {
    expect(classifySecondInstance(parseLaunchIntent(['Amphi.exe', GUI_BACKGROUND_ARG], scheme))).toEqual({
      kind: 'background',
    })
  })

  it('focuses an ordinary second launch', () => {
    expect(classifySecondInstance(parseLaunchIntent(['Amphi.exe'], scheme))).toEqual({ kind: 'focus' })
  })

  it('routes a deep link instead of suppressing it', () => {
    const url = 'amphi://task/456'
    expect(
      classifySecondInstance(parseLaunchIntent(['Amphi.exe', GUI_BACKGROUND_ARG, url], scheme)),
    ).toEqual({ kind: 'deep-link', url })
  })
})

describe('shouldStartBackendForLaunch', () => {
  it('always honors an explicit foreground launch', () => {
    const intent = parseLaunchIntent(['Amphi.exe'], scheme)

    expect(shouldStartBackendForLaunch(intent, null)).toBe(true)
    expect(shouldStartBackendForLaunch(intent, { enabled: false })).toBe(true)
  })

  it('starts from a background login item only when daemon autostart is effective', () => {
    const intent = parseLaunchIntent(['Amphi.exe', GUI_BACKGROUND_ARG], scheme)

    expect(shouldStartBackendForLaunch(intent, { enabled: true })).toBe(true)
    expect(shouldStartBackendForLaunch(intent, { enabled: false })).toBe(false)
    expect(shouldStartBackendForLaunch(intent, null)).toBe(false)
  })

  it('upgrades an existing background process after a later explicit foreground request', () => {
    const intent = parseLaunchIntent(['Amphi.exe', GUI_BACKGROUND_ARG], scheme)

    expect(shouldStartBackendForLaunch(intent, { enabled: false }, true)).toBe(true)
    expect(shouldStartBackendForLaunch(intent, null, true)).toBe(true)
  })
})
