import { describe, expect, it, mock } from 'bun:test'
import {
  RIGHT_PANEL_RAIL_WIDTH,
  SETTINGS_VERSION,
} from '@app/shared/types'
import { electronModuleMock, loggerModuleMock } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { migrate } = await import('../gui-settings')

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
    expect(migrated.layout.rightPanelWidth + RIGHT_PANEL_RAIL_WIDTH).toBe(440)
    expect((migrated.layout.browserPanelWidth ?? 0) + RIGHT_PANEL_RAIL_WIDTH).toBe(640)
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
