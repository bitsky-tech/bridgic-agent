/** Pinned runtimes shared by the resource fetchers and the dev preflight. */

export const UV_VERSION = '0.9.5'
export const PYTHON_VERSION = '3.13.6'
export const NODE_VERSION = 'v22.23.1'

export const PYTHON_TARGETS: Readonly<Record<string, string>> = {
  'darwin-arm64': `cpython-${PYTHON_VERSION}-macos-aarch64-none`,
  'darwin-x64': `cpython-${PYTHON_VERSION}-macos-x86_64-none`,
  'linux-arm64': `cpython-${PYTHON_VERSION}-linux-aarch64-gnu`,
  'linux-x64': `cpython-${PYTHON_VERSION}-linux-x86_64-gnu`,
  'win32-x64': `cpython-${PYTHON_VERSION}-windows-x86_64-none`,
}
