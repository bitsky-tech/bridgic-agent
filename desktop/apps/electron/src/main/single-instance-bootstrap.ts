/**
 * Execute application bootstrap only in the process that owns Electron's
 * single-instance lock. Pure so the lock-denied contract is regression-tested
 * without loading Electron.
 */
export function runPrimaryInstanceBootstrap(
  ownsSingleInstanceLock: boolean,
  bootstrap: () => void,
): boolean {
  if (!ownsSingleInstanceLock) return false
  bootstrap()
  return true
}
