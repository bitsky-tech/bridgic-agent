import { describe, expect, it } from 'bun:test'
import { rendererBuildEnv } from '../electron-build-renderer'

describe('rendererBuildEnv', () => {
  it('raises the Vite heap limit to 4 GiB and keeps other Node options', () => {
    const env = rendererBuildEnv({ NODE_OPTIONS: '--enable-source-maps', PATH: '/bin' })
    expect(env.NODE_OPTIONS).toBe('--enable-source-maps --max-old-space-size=4096')
    expect(env.PATH).toBe('/bin')
  })

  it('sets the flag when NODE_OPTIONS is unset', () => {
    expect(rendererBuildEnv({}).NODE_OPTIONS).toBe('--max-old-space-size=4096')
  })

  it('leaves an explicit caller limit alone in either flag spelling', () => {
    for (const options of ['--max-old-space-size=2048', '--max_old_space_size=2048']) {
      expect(rendererBuildEnv({ NODE_OPTIONS: options }).NODE_OPTIONS).toBe(options)
    }
  })
})
