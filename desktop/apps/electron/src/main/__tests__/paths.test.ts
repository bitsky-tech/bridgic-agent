import { describe, expect, it } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { BACKEND_RUNTIME_DIR_REL } from '../../shared/app-meta'
import { amphiAgentDataDir, embeddedBrowserProfileDir } from '../paths'

describe('Bridgic Agent data paths', () => {
  it('keeps the embedded browser profile beside the shared Python and Node bases', () => {
    const dataDir = path.join(os.homedir(), BACKEND_RUNTIME_DIR_REL)

    expect(amphiAgentDataDir()).toBe(dataDir)
    expect(embeddedBrowserProfileDir()).toBe(path.join(dataDir, 'browser', 'base'))
    expect(path.isAbsolute(embeddedBrowserProfileDir())).toBe(true)
  })
})
