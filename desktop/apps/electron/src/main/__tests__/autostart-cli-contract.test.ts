/**
 * Output contract for `amphi server autostart`: the three verbs use **different formats**.
 *
 * Regression: the first implementation parsed all three verbs as JSON, but only `status`
 * uses `json.dumps`; `enable` and `disable` use `print(f"Autostart enabled via …")` in
 * `src/amphi_cli/_server.py::_autostart`. Every successful toggle was therefore reported as
 * a parse failure. The UI showed an error, the handler returned early, rediscovery was skipped,
 * and the app retained a stale snapshot pointing to a stopped daemon.
 *
 * This asserts the **format contract itself** instead of mocking our own wrapper. The backend
 * CLI output is the part that can drift, so the test reads its print/dumps branches directly.
 * If enable ever switches to JSON, this test will fail and prompt a matching frontend cleanup.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Source of the backend CLI autostart branch under the monorepo root `src/`. */
function autostartSource(): string {
  const path = join(import.meta.dir, '../../../../../..', 'src/amphi_cli/_server.py')
  return readFileSync(path, 'utf-8')
}

function desktopAutostartSource(): string {
  const path = join(import.meta.dir, '..', 'python-client', 'cli.ts')
  return readFileSync(path, 'utf-8')
}

/** Extract the `_autostart` body to avoid matching unrelated print calls in the file. */
function autostartBody(source: string): string {
  const start = source.indexOf('def _autostart(')
  expect(start).toBeGreaterThan(-1)
  const rest = source.slice(start)
  const end = rest.indexOf('\n    @staticmethod')
  return end > 0 ? rest.slice(0, end) : rest
}

describe('amphi server autostart output contract', () => {
  it('emits JSON for `status` only — enable/disable print prose', () => {
    const body = autostartBody(autostartSource())

    // The status branch uses json.dumps, so the frontend can JSON.parse it.
    expect(body).toContain('json.dumps(payload')

    // The enable/disable branches emit human-readable sentences; the frontend must not parse them as JSON.
    expect(body).toMatch(/print\(f"Autostart enabled via/u)
    expect(body).toMatch(/print\(f"Autostart disabled via/u)
  })

  it('keeps legacy lifecycle commands but makes the Desktop toggle configure-only', () => {
    // Installer and explicit CLI calls retain legacy start/stop behavior. Settings must pass
    // configure-only to preserve the current PID, token, and WebSocket.
    const body = autostartBody(autostartSource())
    expect(body).toContain('enable_autostart(')
    expect(body).toContain('disable_autostart(')
    expect(body).toContain('configure_autostart(')
    expect(body).toContain('args.configure_only')
    expect(desktopAutostartSource()).toContain("verb, '--configure-only'")
  })
})
