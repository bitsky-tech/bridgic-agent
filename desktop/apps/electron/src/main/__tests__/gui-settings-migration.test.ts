import { describe, expect, it, mock } from 'bun:test'
import {
  RIGHT_PANEL_RAIL_WIDTH,
  SETTINGS_VERSION,
} from '@app/shared/types'
import { electronModuleMock, loggerModuleMock } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { migrate } = await import('../gui-settings')

/** The rail width as it stood when v3 shipped. A v2 total was measured against THIS
 *  value, so the subtraction is a historical fact and must not follow the live
 *  RIGHT_PANEL_RAIL_WIDTH — redesigning the rail would otherwise silently resize
 *  every upgrading user's panel by the difference. */
const V2_RAIL_WIDTH = 54

describe('GUI settings right dock migration', () => {
  it('preserves v2 panel and Browser total widths after the rail becomes independent', () => {
    const migrated = migrate({
      version: 2,
      layout: {
        rightPanelWidth: 440,
        browserPanelWidth: 640,
      },
    })

    expect(migrated.version).toBe(SETTINGS_VERSION)
    expect(migrated.layout.rightPanelWidth).toBe(440 - V2_RAIL_WIDTH)
    expect(migrated.layout.browserPanelWidth).toBe(640 - V2_RAIL_WIDTH)
  })

  it('does not follow the live rail width when the rail is redesigned', () => {
    // Guards the trap the original assertion could not see: it added the live constant
    // back to the migrated value, which held for any rail width and so proved nothing.
    expect(RIGHT_PANEL_RAIL_WIDTH).not.toBe(V2_RAIL_WIDTH)
    expect(migrate({ version: 2, layout: { rightPanelWidth: 440 } }).layout.rightPanelWidth)
      .toBe(386)
  })

  it('keeps a missing Browser preference missing so first use opens at its minimum', () => {
    const migrated = migrate({
      version: 2,
      layout: { rightPanelWidth: 320 },
    })

    expect(migrated.layout.rightPanelWidth).toBe(320)
    expect(migrated.layout.browserPanelWidth).toBeUndefined()
  })
})
