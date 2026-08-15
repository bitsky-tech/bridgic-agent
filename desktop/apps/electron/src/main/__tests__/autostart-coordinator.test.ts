import { describe, expect, it } from 'bun:test'
import {
  readCombinedAutostart,
  setCombinedAutostart,
  type AutostartCoordinatorDeps,
} from '../autostart-coordinator'
import type { GuiAutostartStatus } from '../gui-autostart'
import type { AutostartStatusJson } from '../python-client/types'

function daemonStatus(enabled: boolean): AutostartStatusJson {
  return {
    manager: 'run-key',
    supported: true,
    enabled,
    active: null,
    definition: 'HKCU Run',
    detail: null,
  }
}

function trayStatus(enabled: boolean, registered = enabled): GuiAutostartStatus {
  return {
    supported: true,
    registered,
    enabled,
    requiresApproval: false,
    detail: null,
  }
}

function harness(options: {
  daemon?: boolean
  tray?: GuiAutostartStatus
  setDaemon?: (enabled: boolean) => boolean | Promise<boolean>
  setTray?: (enabled: boolean) => GuiAutostartStatus
} = {}): {
  deps: AutostartCoordinatorDeps
  events: string[]
  daemonEnabled: () => boolean
  tray: () => GuiAutostartStatus
} {
  let daemonEnabled = options.daemon ?? false
  let tray = options.tray ?? trayStatus(false, false)
  const events: string[] = []

  const deps: AutostartCoordinatorDeps = {
    readDaemon: async () => daemonStatus(daemonEnabled),
    setDaemon: async (enabled) => {
      events.push(`daemon:${enabled}`)
      const changed = await (options.setDaemon?.(enabled) ?? true)
      if (changed) daemonEnabled = enabled
      return changed
    },
    readTray: () => tray,
    setTray: (enabled) => {
      events.push(`tray:${enabled}`)
      tray = options.setTray?.(enabled) ?? trayStatus(enabled, enabled)
      return tray
    },
  }

  return {
    deps,
    events,
    daemonEnabled: () => daemonEnabled,
    tray: () => tray,
  }
}

describe('combined daemon + tray autostart transaction', () => {
  it('enables the visible tray before the daemon', async () => {
    const state = harness()

    const result = await setCombinedAutostart(true, state.deps)

    expect(state.events).toEqual(['tray:true', 'daemon:true'])
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: true, daemon_enabled: true, tray_enabled: true },
    })
  })

  it('repairs a missing tray without restarting an already enabled daemon', async () => {
    const state = harness({ daemon: true })

    const result = await setCombinedAutostart(true, state.deps)

    expect(state.events).toEqual(['tray:true'])
    expect(result).toMatchObject({ ok: true, status: { enabled: true } })
  })

  it('does not enable a new daemon while the OS still blocks the tray', async () => {
    const state = harness({
      setTray: () => ({
        supported: true,
        registered: true,
        enabled: false,
        requiresApproval: true,
        detail: 'approval required',
      }),
    })

    const result = await setCombinedAutostart(true, state.deps)

    expect(state.events).toEqual(['tray:true'])
    expect(state.daemonEnabled()).toBe(false)
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, daemon_enabled: false, tray_requires_approval: true },
    })
  })

  it('removes a newly introduced tray item when daemon enable fails', async () => {
    const state = harness({ setDaemon: () => false })

    const result = await setCombinedAutostart(true, state.deps)

    expect(result).toEqual({ ok: false, reason: 'daemon autostart enable failed' })
    expect(state.events).toEqual(['tray:true', 'daemon:true', 'tray:false'])
    expect(state.daemonEnabled()).toBe(false)
    expect(state.tray().registered).toBe(false)
  })

  it('trusts post-state instead of a timed-out daemon command result', async () => {
    let daemonEnabled = false
    let tray = trayStatus(false, false)
    const events: string[] = []
    const deps: AutostartCoordinatorDeps = {
      readDaemon: async () => daemonStatus(daemonEnabled),
      setDaemon: async (enabled) => {
        events.push(`daemon:${enabled}`)
        daemonEnabled = enabled
        return false
      },
      readTray: () => tray,
      setTray: (enabled) => {
        events.push(`tray:${enabled}`)
        tray = trayStatus(enabled, enabled)
        return tray
      },
    }

    const result = await setCombinedAutostart(true, deps)

    expect(events).toEqual(['tray:true', 'daemon:true'])
    expect(result).toMatchObject({ ok: true, status: { enabled: true } })
  })

  it('does not delete a pre-existing item disabled in Windows Startup Apps', async () => {
    const state = harness({
      tray: {
        ...trayStatus(false, true),
        detail: 'disabled in Startup Apps',
      },
      setDaemon: () => false,
      setTray: () => trayStatus(false, true),
    })

    await setCombinedAutostart(true, state.deps)

    expect(state.events).toEqual(['tray:true'])
    expect(state.daemonEnabled()).toBe(false)
    expect(state.tray().registered).toBe(true)
  })

  it('restores a pre-existing effective opt-out when later daemon enable fails', async () => {
    const state = harness({
      tray: {
        ...trayStatus(false, true),
        detail: 'disabled in Startup Apps',
      },
      setDaemon: () => false,
    })

    const result = await setCombinedAutostart(true, state.deps)

    expect(result).toEqual({ ok: false, reason: 'daemon autostart enable failed' })
    expect(state.events).toEqual(['tray:true', 'daemon:true', 'tray:false'])
    expect(state.daemonEnabled()).toBe(false)
    expect(state.tray().enabled).toBe(false)
  })

  it('disables the daemon before removing the tray', async () => {
    const state = harness({ daemon: true, tray: trayStatus(true) })

    const result = await setCombinedAutostart(false, state.deps)

    expect(state.events).toEqual(['daemon:false', 'tray:false'])
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, daemon_enabled: false, tray_registered: false },
    })
  })

  it('deletes a registered daemon even when StartupApproved already makes it ineffective', async () => {
    const state = harness({ daemon: false, tray: trayStatus(true) })

    const result = await setCombinedAutostart(false, state.deps)

    expect(state.events).toEqual(['daemon:false', 'tray:false'])
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, daemon_enabled: false, tray_registered: false },
    })
  })

  it('keeps the tray when deleting an already ineffective daemon is unconfirmed', async () => {
    const state = harness({
      daemon: false,
      tray: trayStatus(true),
      setDaemon: () => false,
    })

    const result = await setCombinedAutostart(false, state.deps)

    expect(result).toEqual({ ok: false, reason: 'daemon autostart disable failed' })
    expect(state.events).toEqual(['daemon:false'])
    expect(state.tray().registered).toBe(true)
  })

  it('keeps the tray when deleting an already ineffective daemon throws', async () => {
    const state = harness({
      daemon: false,
      tray: trayStatus(true),
      setDaemon: () => { throw new Error('CLI blocked') },
    })

    const result = await setCombinedAutostart(false, state.deps)

    expect(result).toEqual({ ok: false, reason: 'daemon autostart disable failed' })
    expect(state.events).toEqual(['daemon:false'])
    expect(state.tray().registered).toBe(true)
  })

  it('keeps the tray when a timed-out disable only reports an ineffective post-state', async () => {
    let daemonEnabled = true
    let tray = trayStatus(true)
    const events: string[] = []
    const deps: AutostartCoordinatorDeps = {
      readDaemon: async () => daemonStatus(daemonEnabled),
      setDaemon: async (enabled) => {
        events.push(`daemon:${enabled}`)
        daemonEnabled = enabled
        return false
      },
      readTray: () => tray,
      setTray: (enabled) => {
        events.push(`tray:${enabled}`)
        tray = trayStatus(enabled, enabled)
        return tray
      },
    }

    const result = await setCombinedAutostart(false, deps)

    expect(result).toEqual({ ok: false, reason: 'daemon autostart disable failed' })
    expect(events).toEqual(['daemon:false'])
    expect(tray.registered).toBe(true)
  })

  it('leaves the diagnostic tray in place when daemon disable fails', async () => {
    const state = harness({
      daemon: true,
      tray: trayStatus(true),
      setDaemon: () => false,
    })

    const result = await setCombinedAutostart(false, state.deps)

    expect(result).toEqual({ ok: false, reason: 'daemon autostart disable failed' })
    expect(state.events).toEqual(['daemon:false'])
    expect(state.tray().enabled).toBe(true)
  })

  it('treats a thrown daemon control as failure and leaves the tray observable', async () => {
    const state = harness({
      daemon: true,
      tray: trayStatus(true),
      setDaemon: () => { throw new Error('CLI blocked') },
    })

    const result = await setCombinedAutostart(false, state.deps)

    expect(result).toEqual({ ok: false, reason: 'daemon autostart disable failed' })
    expect(state.events).toEqual(['daemon:false'])
    expect(state.tray().registered).toBe(true)
  })

  it('restores the daemon if removing the tray throws', async () => {
    const state = harness({
      daemon: true,
      tray: trayStatus(true),
      setTray: () => { throw new Error('registry denied') },
    })

    const result = await setCombinedAutostart(false, state.deps)

    expect(result).toEqual({
      ok: false,
      reason: 'tray autostart disable failed: registry denied',
    })
    expect(state.events).toEqual(['daemon:false', 'tray:false', 'daemon:true'])
    expect(state.daemonEnabled()).toBe(true)
  })

  it('restores the daemon when tray removal silently fails its readback', async () => {
    const state = harness({
      daemon: true,
      tray: trayStatus(true),
      setTray: () => ({
        ...trayStatus(true),
        detail: 'still enabled by the OS',
      }),
    })

    const result = await setCombinedAutostart(false, state.deps)

    expect(result).toEqual({
      ok: false,
      reason: 'tray autostart disable failed: still enabled by the OS',
    })
    expect(state.events).toEqual(['daemon:false', 'tray:false', 'daemon:true'])
    expect(state.daemonEnabled()).toBe(true)
  })

  it('reports daemon-only drift instead of claiming the product is enabled', async () => {
    const state = harness({ daemon: true, tray: trayStatus(false, false) })

    const result = await readCombinedAutostart(state.deps)

    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, daemon_enabled: true, tray_enabled: false },
    })
  })

  it('fails closed when the tray registration cannot be read', async () => {
    let daemonWrites = 0
    const deps: AutostartCoordinatorDeps = {
      readDaemon: async () => daemonStatus(true),
      setDaemon: async () => {
        daemonWrites += 1
        return true
      },
      readTray: () => { throw new Error('registry unavailable') },
      setTray: () => trayStatus(false, false),
    }

    const result = await setCombinedAutostart(false, deps)

    expect(result).toEqual({ ok: false, reason: 'tray autostart status unavailable' })
    expect(daemonWrites).toBe(0)
  })
})
