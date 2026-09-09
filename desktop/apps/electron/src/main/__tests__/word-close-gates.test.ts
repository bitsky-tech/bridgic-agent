import { describe, expect, it } from 'bun:test'

const loggerPath = import.meta.resolve('../logger.ts')
const settingsPath = import.meta.resolve('../gui-settings.ts')
const windowManagerPath = import.meta.resolve('../window-manager.ts')
const updateHandlerPath = import.meta.resolve('../handlers/update.ts')
const autoUpdatePath = import.meta.resolve('../auto-update.ts')
const pythonClientPath = import.meta.resolve('../python-client/index.ts')
const quitPath = import.meta.resolve('../quit-with-daemon.ts')
const ipcPath = import.meta.resolve('../../shared/ipc-channels.ts')

/** Isolate mocks of desktop startup modules from the shared main-process test suite. */
async function runIsolated(body: string): Promise<Record<string, unknown>> {
  const script = `
    import { mock } from 'bun:test';
    const calls = [];
    const handlers = new Map();
    const dialogs = [];
    const windowForUpdate = { isVisible: () => true, hide: () => calls.push('hide'), show: () => calls.push('show') };
    mock.module('electron', () => ({
      BrowserWindow: { getAllWindows: () => { calls.push('list-windows'); return [windowForUpdate]; } },
      WebContentsView: class {},
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' },
      dialog: { showMessageBox: async (...args) => { dialogs.push(args.at(-1)); return { response: 0 }; } },
      nativeTheme: { themeSource: 'system' }, screen: {}, session: {}, shell: {},
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    }));
    const noop = () => {};
    const logger = { debug: noop, error: noop, info: noop, warn: noop };
    mock.module(${JSON.stringify(loggerPath)}, () => ({
      windowLog: logger, mainLog: logger, updateLog: logger, handlerLog: logger,
      telemetryLog: logger, isDebugMode: true, getLogFilePath: noop,
    }));
    mock.module(${JSON.stringify(settingsPath)}, () => ({
      getGuiSettings: () => ({}), onGuiSettingsChanged: () => noop,
      stepZoomLevel: noop, updateWindowState: noop,
    }));
    mock.module(${JSON.stringify(autoUpdatePath)}, () => ({
      hasStagedUpdate: () => true, getUpdateStatus: () => ({}), requestManualCheck: async () => 'started',
      quitAndInstall: () => calls.push('install'),
    }));
    mock.module(${JSON.stringify(pythonClientPath)}, () => ({ pythonClient: {
      stopDaemon: async () => { calls.push('stop-daemon'); return true; }, snapshot: () => ({ endpoint: null }),
    } }));
    mock.module(${JSON.stringify(quitPath)}, () => ({
      markQuitConfirmed: () => calls.push('mark-quit'), clearQuitConfirmed: () => calls.push('clear-quit'),
    }));
    const { WindowManager } = await import(${JSON.stringify(windowManagerPath)});
    const { registerUpdateHandlers } = await import(${JSON.stringify(updateHandlerPath)});
    const { IPC } = await import(${JSON.stringify(ipcPath)});
    const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
    const deferred = () => {
      let resolve;
      let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    };
    const fixture = (flush) => {
      let destroys = 0;
      let flushes = 0;
      let destroyed = false;
      const win = { isDestroyed: () => destroyed, destroy: () => { destroys += 1; destroyed = true; } };
      const manager = Object.create(WindowManager.prototype);
      Object.assign(manager, {
        mainWindow: win, pendingCloseTimeout: null, closeGeneration: 0,
        closingWindow: null, wordFlush: null,
        wordHost: { flushAll: () => { flushes += 1; return flush(); } },
      });
      return { manager, win, snapshot: () => ({ destroys, flushes, destroyed }) };
    };
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

describe('Word persistence gates for native shutdown', () => {
  it('does not destroy the main window until its Word checkpoint acknowledges success', async () => {
    const result = await runIsolated(`
      const checkpoint = deferred();
      const state = fixture(() => checkpoint.promise);
      const closing = state.manager.confirmClose();
      await settle();
      const before = state.snapshot();
      checkpoint.resolve(true);
      await closing;
      console.log(JSON.stringify({ before, after: state.snapshot() }));
    `)
    expect(result.before).toEqual({ destroys: 0, flushes: 1, destroyed: false })
    expect(result.after).toEqual({ destroys: 1, flushes: 1, destroyed: true })
  })

  it('keeps the window available on a refused or rejected checkpoint', async () => {
    const result = await runIsolated(`
      const refused = fixture(async () => false);
      await refused.manager.confirmClose();
      const rejected = fixture(async () => { throw new Error('persistence unavailable'); });
      await rejected.manager.confirmClose();
      console.log(JSON.stringify({ refused: refused.snapshot(), rejected: rejected.snapshot(), dialogCount: dialogs.length }));
    `)
    expect(result.refused).toEqual({ destroys: 0, flushes: 1, destroyed: false })
    expect(result.rejected).toEqual({ destroys: 0, flushes: 1, destroyed: false })
    expect(result.dialogCount).toBe(1)
  })

  it('coalesces duplicate close confirmations and checkpoint requests', async () => {
    const result = await runIsolated(`
      const checkpoint = deferred();
      const state = fixture(() => checkpoint.promise);
      const first = state.manager.confirmClose();
      const second = state.manager.confirmClose();
      const checkpointA = state.manager.flushWordDocuments();
      const checkpointB = state.manager.flushWordDocuments();
      const sameClose = first === second;
      const sameCheckpoint = checkpointA === checkpointB;
      await settle();
      const before = state.snapshot();
      checkpoint.resolve(true);
      await Promise.all([first, second, checkpointA, checkpointB]);
      console.log(JSON.stringify({ before, after: state.snapshot(), sameClose, sameCheckpoint }));
    `)
    expect(result.sameClose).toBe(true)
    expect(result.sameCheckpoint).toBe(true)
    expect(result.before).toEqual({ destroys: 0, flushes: 1, destroyed: false })
    expect(result.after).toEqual({ destroys: 1, flushes: 1, destroyed: true })
  })

  it('invalidates a cancelled in-flight confirmation while permitting a later explicit close', async () => {
    const result = await runIsolated(`
      const checkpoint = deferred();
      const state = fixture(() => checkpoint.promise);
      const closing = state.manager.confirmClose();
      await settle();
      state.manager.cancelClose();
      checkpoint.resolve(true);
      await closing;
      await settle();
      const cancelled = state.snapshot();
      await state.manager.confirmClose();
      console.log(JSON.stringify({ cancelled, afterRetry: state.snapshot() }));
    `)
    expect(result.cancelled).toEqual({ destroys: 0, flushes: 1, destroyed: false })
    expect(result.afterRetry).toEqual({ destroys: 1, flushes: 2, destroyed: true })
  })

  it('does not apply an old confirmation to a replacement main window', async () => {
    const result = await runIsolated(`
      const checkpoint = deferred();
      const state = fixture(() => checkpoint.promise);
      const replacement = fixture(async () => true);
      const closing = state.manager.confirmClose();
      await settle();
      state.manager.mainWindow = replacement.win;
      checkpoint.resolve(true);
      await closing;
      console.log(JSON.stringify({ oldWindow: state.snapshot(), replacement: replacement.snapshot() }));
    `)
    expect(result.oldWindow).toEqual({ destroys: 0, flushes: 1, destroyed: false })
    expect(result.replacement).toEqual({ destroys: 0, flushes: 0, destroyed: false })
  })

  it('does not hide windows, stop the daemon or install an update before a failed Word checkpoint', async () => {
    const result = await runIsolated(`
      const checkpoint = deferred();
      registerUpdateHandlers({ confirmClose: async () => { calls.push('excel-confirm'); return true; } }, () => {
        calls.push('flush-word');
        return checkpoint.promise;
      });
      const installing = handlers.get(IPC.update.installNow)({});
      await settle();
      const before = [...calls];
      checkpoint.resolve(false);
      const outcome = await installing;
      console.log(JSON.stringify({ before, after: calls, outcome }));
    `)
    expect(result.before).toEqual(['excel-confirm', 'flush-word'])
    expect(result.after).toEqual(['excel-confirm', 'flush-word'])
    expect(result.outcome).toEqual({ ok: false, reason: 'unsaved-documents' })
  })

  it('begins the update handover only after the Word checkpoint succeeds', async () => {
    const result = await runIsolated(`
      const checkpoint = deferred();
      registerUpdateHandlers({ confirmClose: async () => true }, () => {
        calls.push('flush-word');
        return checkpoint.promise;
      });
      const installing = handlers.get(IPC.update.installNow)({});
      await settle();
      const before = [...calls];
      checkpoint.resolve(true);
      const outcome = await installing;
      console.log(JSON.stringify({ before, after: calls, outcome }));
    `)
    expect(result.before).toEqual(['flush-word'])
    expect(result.after).toEqual(['flush-word', 'list-windows', 'hide', 'stop-daemon', 'mark-quit', 'install'])
    expect(result.outcome).toEqual({ ok: true })
  })
})
