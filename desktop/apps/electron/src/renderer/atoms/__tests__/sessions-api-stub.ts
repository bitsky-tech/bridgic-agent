/**
 * Install `window.api.sessions.*` for atom tests, without trampling a DOM.
 *
 * The session atoms fire-and-forget IPC on every meta mutation, so a test that
 * touches them needs `window.api.sessions` to exist. Two files used to get
 * there by assigning a bare object over `globalThis.window` at module scope and
 * never putting it back.
 *
 * Both halves of that were a problem. Replacing the global means that if a
 * happy-dom test file ran earlier and is still registered, its `window` — the
 * one its own `afterAll` is about to hand back to `GlobalRegistrator` — is
 * gone, so the unregister leaves the process in a state where the next
 * `register()` throws. Never restoring means the fake `window` outlives this
 * file and is visible to every file that follows, which makes the suite's
 * result depend on the order bun happens to walk the directory in — green on
 * one machine, 55 failures on another.
 *
 * So: graft `api` onto whatever `window` is already there when there is one,
 * fall back to a minimal stand-in when there is not, and give the caller an
 * exact inverse to run in `afterAll`.
 */

interface SessionsApi {
  listMeta: (...args: never[]) => unknown
  loadMessages: (...args: never[]) => unknown
  appendMessage: (...args: never[]) => unknown
  saveMeta: (...args: never[]) => unknown
  deleteSession: (...args: never[]) => unknown
}

type MutableWindow = { api?: unknown }
type Globals = { window?: unknown }

/**
 * Returns the teardown. Call it from `afterAll` — leaving it uncalled is the
 * defect this module exists to remove.
 */
export function installSessionsApiStub(sessions: SessionsApi): () => void {
  const globals = globalThis as Globals
  const existingWindow = globals.window

  if (existingWindow && typeof existingWindow === 'object') {
    const host = existingWindow as MutableWindow
    const hadApi = 'api' in host
    const previousApi = host.api
    host.api = { ...(previousApi as object | undefined), sessions }
    return () => {
      if (hadApi) host.api = previousApi
      else delete host.api
    }
  }

  globals.window = { api: { sessions } } as never
  return () => {
    globals.window = existingWindow
  }
}
