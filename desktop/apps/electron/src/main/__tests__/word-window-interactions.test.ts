import { describe, expect, it } from 'bun:test'
import { ZOOM_LEVEL_STEP } from '@app/shared/types'

const windowManagerPath = import.meta.resolve('../window-manager.ts')
const loggerPath = import.meta.resolve('../logger.ts')
const settingsPath = import.meta.resolve('../gui-settings.ts')
const i18nPath = import.meta.resolve('../i18n.ts')
const browserPath = import.meta.resolve('../embedded-browser-manager.ts')
const powerPointPath = import.meta.resolve('../embedded-powerpoint-manager.ts')
const excelPath = import.meta.resolve('../excel-host.ts')
const wordPath = import.meta.resolve('../word-host.ts')

/** Exercise the real WindowManager wiring without leaking startup mocks into other tests. */
async function runIsolated(platform: 'darwin' | 'win32' | 'linux', body: string): Promise<Record<string, unknown>> {
  const script = `
    import { mock } from 'bun:test';
    import { EventEmitter } from 'node:events';
    const zoomSteps = [];
    const externalUrls = [];
    const warnings = [];
    const unhandled = [];
    let rejectExternal = false;
    let wordFactory;
    let wordOpenExternal;
    const noop = () => {};
    process.on('unhandledRejection', (error) => unhandled.push(String(error)));
    mock.module('electron', () => ({
      BrowserWindow: class {},
      WebContentsView: class {
        constructor(options) { this.options = options; this.webContents = new EventEmitter(); }
      },
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' },
      dialog: {}, nativeTheme: {}, screen: {}, session: {},
      shell: { openExternal: async (url) => {
        externalUrls.push(url);
        if (rejectExternal) throw new Error('No application can open this URL');
      } },
    }));
    const logger = { debug: noop, error: noop, info: noop, warn: (message) => warnings.push(message) };
    mock.module(${JSON.stringify(loggerPath)}, () => ({
      windowLog: logger, mainLog: logger, handlerLog: logger, telemetryLog: logger,
      isDebugMode: true, getLogFilePath: noop,
    }));
    mock.module(${JSON.stringify(settingsPath)}, () => ({
      getGuiSettings: () => ({ zoomLevel: 0 }), onGuiSettingsChanged: () => noop,
      stepZoomLevel: (delta) => zoomSteps.push(delta), updateWindowState: noop,
    }));
    mock.module(${JSON.stringify(i18nPath)}, () => ({ mt: (key) => key }));
    mock.module(${JSON.stringify(browserPath)}, () => ({ EmbeddedBrowserManager: class {} }));
    mock.module(${JSON.stringify(powerPointPath)}, () => ({ EmbeddedPowerPointManager: class { applySettings() {} } }));
    mock.module(${JSON.stringify(excelPath)}, () => ({ ExcelHost: class {} }));
    mock.module(${JSON.stringify(wordPath)}, () => ({ WordHost: class {
      constructor(createView, _loadView, _onStateChanged, openExternal) {
        wordFactory = createView;
        wordOpenExternal = openExternal;
      }
      applySettings() {}
    } }));
    const { WindowManager } = await import(${JSON.stringify(windowManagerPath)});
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const manager = new WindowManager({
      preloadPath: '/test/preload.cjs', excelPreloadPath: '/test/excel-preload.cjs',
      wordPreloadPath: '/test/word-preload.cjs', rendererIndexHtml: '/test/index.html',
      excelRendererHtml: '/test/excel.html',
    });
    const view = wordFactory({ webPreferences: { sandbox: true, contextIsolation: true } });
    const modifier = process.platform === 'darwin' ? { meta: true } : { control: true };
    const wrongModifier = process.platform === 'darwin' ? { control: true } : { meta: true };
    const press = (input) => {
      let prevented = 0;
      const before = zoomSteps.length;
      view.webContents.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, {
        type: 'keyDown', key: '', code: '', shift: false, meta: false, control: false, ...input,
      });
      return { prevented, steps: zoomSteps.slice(before) };
    };
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    ${body}
  `
  const subprocess = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
  ])
  expect(stderr).toBe('')
  expect(code).toBe(0)
  return JSON.parse(stdout) as Record<string, unknown>
}

describe('Word native view application interactions', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`binds supplementary zoom keys exactly once to the Word view on ${platform}`, async () => {
      const result = await runIsolated(platform, `
        const cases = [
          { key: '=', code: 'Equal' },
          { key: '+', code: 'NumpadAdd' },
          { key: '-', code: 'NumpadSubtract' },
        ].map((input) => press({ ...modifier, ...input }));
        console.log(JSON.stringify({
          cases, bindings: view.webContents.listenerCount('before-input-event'), options: view.options,
        }));
      `)
      expect(result.bindings).toBe(1)
      expect(result.options).toEqual({
        webPreferences: { sandbox: true, contextIsolation: true, preload: '/test/word-preload.cjs' },
      })
      expect(result.cases).toEqual([
        { prevented: 1, steps: [ZOOM_LEVEL_STEP] },
        { prevented: 1, steps: [ZOOM_LEVEL_STEP] },
        { prevented: 1, steps: [-ZOOM_LEVEL_STEP] },
      ])
    })

    it(`leaves typing and canonical menu accelerators alone on ${platform}`, async () => {
      const result = await runIsolated(platform, `
        const cases = [
          { key: '=', code: 'Equal' },
          { ...wrongModifier, key: '=', code: 'Equal' },
          { ...modifier, type: 'keyUp', key: '=', code: 'Equal' },
          { ...modifier, key: '+', code: 'Equal', shift: true },
          { ...modifier, key: '=', code: 'Equal', shift: true },
          { ...modifier, key: '-', code: 'Minus' },
          { ...modifier, key: '0', code: 'Digit0' },
        ].map(press);
        console.log(JSON.stringify({ cases }));
      `)
      expect(result.cases).toEqual(Array.from({ length: 7 }, () => ({ prevented: 0, steps: [] })))
    })

    it(`retains close shortcut intent without intercepting the menu close action on ${platform}`, async () => {
      const result = await runIsolated(platform, `
        const ignored = [
          { key: 'w', code: 'KeyW' },
          { ...wrongModifier, key: 'w', code: 'KeyW' },
          { ...modifier, type: 'keyUp', key: 'w', code: 'KeyW' },
        ].map((input) => ({ ...press(input), intent: manager.keyboardCloseIntent }));
        const close = press({ ...modifier, key: 'W', code: 'KeyW' });
        const intent = manager.keyboardCloseIntent;
        await new Promise((resolve) => setTimeout(resolve, 550));
        console.log(JSON.stringify({ ignored, close, intent, expired: manager.keyboardCloseIntent }));
      `)
      expect(result.ignored).toEqual(Array.from({ length: 3 }, () => ({ prevented: 0, steps: [], intent: false })))
      expect(result.close).toEqual({ prevented: 0, steps: [] })
      expect(result.intent).toBe(true)
      expect(result.expired).toBe(false)
    })
  }

  it('passes only approved external URL schemes from Word to the system browser', async () => {
    const result = await runIsolated('darwin', `
      for (const url of [
        'https://example.com/report?view=word#page', 'http://example.com/', 'mailto:author@example.com',
        'file:///tmp/private.txt', 'javascript:alert(1)', 'data:text/html,hello', 'bridgic://settings', 'not a URL',
      ]) wordOpenExternal(url);
      await settle();
      console.log(JSON.stringify({ externalUrls, warningCount: warnings.length, unhandled }));
    `)
    expect(result.externalUrls).toEqual([
      'https://example.com/report?view=word#page', 'http://example.com/', 'mailto:author@example.com',
    ])
    expect(result.warningCount).toBe(5)
    expect(result.unhandled).toEqual([])
  })

  it('handles a system browser rejection without leaking URL secrets or an unhandled rejection', async () => {
    const result = await runIsolated('darwin', `
      rejectExternal = true;
      wordOpenExternal('https://example.com/report?token=secret#private');
      await settle();
      await settle();
      console.log(JSON.stringify({ externalUrls, warnings, unhandled }));
    `)
    expect(result.externalUrls).toEqual(['https://example.com/report?token=secret#private'])
    expect(result.warnings).toEqual([
      '[window] openExternal failed source=word url=https://example.com/report?[redacted]#[redacted]',
    ])
    expect(result.unhandled).toEqual([])
  })
})
