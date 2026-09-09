import { expect, it } from 'bun:test'

it('buffers early Word runtime events and exposes only its narrow Session API', async () => {
  // A subprocess keeps the preload's Electron mock out of main-process test modules.
  const script = `
    import { mock } from 'bun:test';
    const listeners = new Map();
    const invocations = [];
    let exposed;
    mock.module('electron', () => ({
      contextBridge: { exposeInMainWorld(name, api) { exposed = { name, api }; } },
      ipcRenderer: {
        on(channel, listener) { listeners.set(channel, listener); },
        invoke(...args) { invocations.push(args); return Promise.resolve(); },
      },
    }));
    await import(${JSON.stringify(import.meta.resolve('../../preload/word-host.ts'))});
    const { IPC } = await import(${JSON.stringify(import.meta.resolve('../../shared/ipc-channels.ts'))});
    const emit = (channel, value) => listeners.get(channel)?.({}, value);
    const request = { id: 'opaque-ticket', sessionId: 'a', name: 'a.docx', path: '/tmp/a.docx' };
    emit(IPC.events.wordHostOpenFileRequested, request);
    emit(IPC.events.wordHostFlushRequested, 'flush-ticket');
    emit(IPC.events.wordHostConfigChanged, { locale: 'en' });
    emit(IPC.events.wordHostConfigChanged, { locale: 'zh' });
    emit(IPC.events.wordHostExpandedChanged, { sessionId: 'a', expanded: true });
    const received = [];
    const stopOpen = exposed.api.onOpenFileRequested((value) => received.push(['open', value]));
    exposed.api.onFlushRequested((value) => received.push(['flush', value]));
    exposed.api.onConfigChanged((value) => received.push(['config', value]));
    exposed.api.onExpandedChanged((value) => received.push(['expanded', value]));
    stopOpen();
    emit(IPC.events.wordHostOpenFileRequested, { ...request, id: 'second-ticket' });
    exposed.api.onOpenFileRequested((value) => received.push(['replayed', value]));
    await exposed.api.readDocument('/tmp/a.docx');
    await exposed.api.completeOpenFile('opaque-ticket');
    await exposed.api.completeFlush('flush-ticket', true);
    await exposed.api.reportState({ documentCount: 1, persistenceStatus: 'saved' });
    console.log(JSON.stringify({ name: exposed.name, keys: Object.keys(exposed.api), received, invocations }));
  `
  const subprocess = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
  ])
  expect(stderr).toBe('')
  expect(code).toBe(0)
  const result = JSON.parse(stdout) as { name: string; keys: string[]; received: unknown[][]; invocations: unknown[][] }
  expect(result.name).toBe('wordHostApi')
  expect(result.keys.sort()).toEqual([
    'completeFlush', 'completeOpenFile', 'getConfig', 'onConfigChanged', 'onExpandedChanged',
    'onFlushRequested', 'onOpenFileRequested', 'readDocument', 'reportState', 'requestHide', 'setExpanded',
  ].sort())
  expect(result.received.map(([kind]) => kind)).toEqual(['open', 'flush', 'config', 'expanded', 'replayed'])
  expect(result.received[2]).toEqual(['config', { locale: 'zh' }])
  expect(result.invocations).toEqual([
    ['word:read-document', '/tmp/a.docx'],
    ['word-host:completeOpenFile', 'opaque-ticket', null],
    ['word-host:completeFlush', 'flush-ticket', true],
    ['word-host:reportState', { documentCount: 1, persistenceStatus: 'saved' }],
  ])
})
