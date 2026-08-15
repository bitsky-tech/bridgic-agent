/**
 * Shell Environment Loader (macOS only).
 *
 * When Electron is launched from Finder/Dock, it inherits a minimal launchd
 * environment (PATH=/usr/bin:/bin:/usr/sbin:/sbin) and does NOT execute the
 * user's shell rc files. So Homebrew binaries (`gh`, `brew`), nvm, pyenv,
 * etc. are invisible.
 *
 * This loader spawns the user's login shell, reads its full environment, and
 * merges it into process.env before any subprocess is spawned.
 */

import { execSync } from 'node:child_process'
import { mainLog } from './logger'

const shouldSkipEnvVar = (key: string): boolean => {
  // VITE_* vars from dev mode would make a packaged app try to load from localhost.
  return key.startsWith('VITE_')
}

export function loadShellEnv(): void {
  if (process.platform !== 'darwin') return

  // Dev mode launches from a terminal — environment is already complete.
  if (process.env.VITE_DEV_SERVER_URL) {
    mainLog.info('[shell-env] dev mode, skipping')
    return
  }

  const shell = process.env.SHELL || '/bin/zsh'
  mainLog.info(`[shell-env] loading from ${shell}`)

  try {
    const output = execSync(`${shell} -l -i -c 'echo __ENV_START__ && env'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        SHELL: shell,
        TERM: 'xterm-256color',
        TMPDIR: process.env.TMPDIR,
        APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const envSection = output.split('__ENV_START__')[1] || ''
    let count = 0
    for (const line of envSection.trim().split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.substring(0, eq)
      if (shouldSkipEnvVar(key)) continue
      process.env[key] = line.substring(eq + 1)
      count++
    }
    mainLog.info(`[shell-env] loaded ${count} variables`)
  } catch (err) {
    // §1.3: pass Error as second arg so electron-log preserves stack.
    mainLog.warn('[shell-env] shell env load failed; falling back to common paths', err)
    const fallback = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.bun/bin`,
      `${process.env.HOME}/.cargo/bin`,
    ]
    const current = (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':')
    process.env.PATH = [...fallback, ...current].filter((p, i, arr) => arr.indexOf(p) === i).join(':')
  }
}
