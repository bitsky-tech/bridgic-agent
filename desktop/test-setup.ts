/**
 * Bun test preload — neutralize `electron-log/renderer`.
 *
 * Why: on import with a `window` global present, electron-log/renderer takes
 * its renderer branch and registers a `window.addEventListener('message', …)`
 * plus an ipc transport (node_modules/electron-log/src/renderer/index.js:57).
 * Several atom tests stub `globalThis.window` and never tear it down, so the
 * real module leaves an active handle that keeps the Bun test process alive
 * after every test has passed — which times out the Windows CI job at 15m
 * (mac/linux happen to let the process exit). Tests never assert on log
 * output, so a no-op stub is safe and removes the handle entirely.
 *
 * Also boots i18next once for the whole run: `useTranslation()` falls back to
 * echoing the raw key when no instance was registered, so any test rendering a
 * translated component would assert against `foo.bar` instead of real copy.
 * Importing the renderer's i18n module here registers the singleton before the
 * first test file loads, regardless of that file's own import graph.
 *
 * Loaded via `--preload` in package.json's `test` script so it runs before
 * any test file imports the logger.
 */
import { mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Stub the four SVG assets the renderer imports for their URL.
//
// Vite resolves `import url from '@/assets/logo.svg'` to a string; bun:test has
// no such loader and parses the file as JSX, dying on the `?` of `<?xml`. Only
// `Primitives.tsx` imports them, and it sits behind `@/atoms/update` — a path
// two component tests already `mock.module()`. Bun's module mocks are
// process-global and outlive the file that registers them, so in a full run the
// real import was never evaluated and nobody noticed. Run one of the innocent
// files on its own, the way anyone bisecting a failure would, and it dies on an
// SVG it never mentions.
//
// Done with `mock.module` rather than a `Bun.plugin` loader on purpose:
// registering an onLoad plugin changes the module pipeline for EVERY file, and
// measurably did — a Mermaid rendering test started failing with a plugin whose
// filter could not even match the files it loads. Four explicit stubs cannot
// reach anything they were not aimed at.
for (const asset of ['icon-light', 'icon-dark', 'logo', 'logo-dark']) {
  const path = `./apps/electron/src/renderer/assets/${asset}.svg`
  mock.module(path, () => ({ default: path }))
}
import { i18n } from './apps/electron/src/renderer/lib/i18n'

// ── happy-dom: make the per-file register/unregister pairs collision-proof ──
//
// 49 test files each do `GlobalRegistrator.register()` at module scope and
// `await GlobalRegistrator.unregister()` in `afterAll`. That is deliberate and
// documented (see composer/__tests__/caretDom.test.ts): a DOM hung on the
// global for the WHOLE run fights with the atom tests that install their own
// `globalThis.window`, so the DOM is meant to exist only while a DOM test file
// is actually running.
//
// The flaw is that the scheme has no tolerance for a single leaked
// registration. `register()` THROWS when a previous file's `unregister()` did
// not run — and it throws at module-evaluation time, before any hook of the
// new file exists, so that file registers no `afterAll` either. Every later
// DOM file then hits the same throw. One leak silently becomes a whole-suite
// cascade: on the CI runner (ubuntu-24.04, bun 1.3.14) 55 tests failed and all
// but one of the DOM test files aborted during module evaluation, while the
// identical commit and bun version pass locally — the signature of
// order-dependent global state rather than of any one broken test.
//
// Reference-counting turns that cascade back into what it should always have
// been: at worst the DOM outlives one file. `register()` after a leak is a
// no-op on a DOM that is still perfectly usable, so the tests that would have
// died on an unrelated file's mistake simply run.
//
// Patched here rather than in 49 call sites because the preload is already
// where this file neutralizes cross-file global hazards (electron-log's
// message listener, the unregistered i18next singleton), and because a fix
// spread over 49 files is one careless copy-paste away from being undone.
let domRegistrations = 0
const registerDom = GlobalRegistrator.register.bind(GlobalRegistrator)
const unregisterDom = GlobalRegistrator.unregister.bind(GlobalRegistrator)

GlobalRegistrator.register = ((options?: Parameters<typeof registerDom>[0]) => {
  if (domRegistrations === 0) registerDom(options)
  domRegistrations += 1
  // Clear any `window.api` an earlier file left behind.
  //
  // `installApiStub()` (lib/apiStub.ts) returns early when `window.api`
  // already exists — deliberately, so the stub can never shadow the real
  // preload-injected bridge. Eleven test files install a PARTIAL api of their
  // own (`{ window, events }`, `{ backend }`, …) and never remove it, so the
  // next file to ask for the full stub silently gets those two keys instead.
  // That is how three WorkflowRunDetailModal tests fail on
  // `window.api.dialog.save` in a full run and pass on their own.
  //
  // Here is the one moment where clearing is unambiguously right: a file is
  // starting, and whatever `api` is on the global belongs to a file that has
  // already finished its tests. Fixing it per-file means patching every
  // current leaker and trusting the next one to remember.
  delete (globalThis as { window?: { api?: unknown } }).window?.api
}) as typeof GlobalRegistrator.register

GlobalRegistrator.unregister = (async () => {
  // Guard the floor: an unbalanced `unregister()` must not drive the count
  // negative, or the next `register()` would skip the real registration and
  // hand that file a DOM-less global.
  if (domRegistrations === 0) return
  domRegistrations -= 1
  if (domRegistrations === 0) await unregisterDom()
}) as typeof GlobalRegistrator.unregister

// Pin the run's language here rather than in the app bundle. happy-dom hard-codes
// `navigator.language` to `en-US`, so without a pin the detector ships English into every
// test and invalidates the Chinese copy the assertions were written against. It used to be
// a `typeof Bun !== 'undefined'` branch inside lib/i18n.ts, which put test-only behaviour
// in shipped code and — worse — made English unreachable from any test: a test that wants
// the other language can now just `await i18n.changeLanguage('en')` and restore afterwards.
await i18n.changeLanguage('zh')

const noop = (): void => {}
const stub: Record<string, unknown> = {
  error: noop,
  warn: noop,
  info: noop,
  verbose: noop,
  debug: noop,
  silly: noop,
  log: noop,
  scope: () => stub,
}

mock.module('electron-log/renderer', () => ({ default: stub, ...stub }))
