/**
 * GatewayBootGate 的版本闸门分支。
 *
 * 覆盖的都是「静默失败」类的约束——它们出错时不会抛异常，只会让用户在一个
 * 半升级的状态里继续用应用：
 *  - `incompatible` 必须**挡住** children（放行就等于让新 GUI 驱动旧 daemon）；
 *  - 在用户点按钮之前，**绝不**能调用 `resolveCompatibility`（重启会掐断
 *    其它客户端正在跑的活）；
 *  - `unknown`（daemon 没上报版本）走独立文案，不能复用「版本不匹配」的说法；
 *  - `compatibility` 为 null（开发构建没有 manifest）时闸门不生效。
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createStore, Provider } from 'jotai'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { issueReportRequestAtom } = await import('@/atoms/issue-report')
const { BackendState, CompatibilityState } = await import('../../../../main/python-client/types')
const { GatewayBootGate } = await import('../GatewayBootGate')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const resolveCompatibility = mock(async () => ({
  state: BackendState.Ready,
  endpoint: null,
  lastError: null,
  compatibility: { state: CompatibilityState.Compatible },
}))
type ClientRow = { client_id: string; client_type: string }
const getClients = mock<() => Promise<{ ok: true; clients: ClientRow[] } | { ok: false; reason: string }>>(
  async () => ({ ok: true, clients: [] }),
)
const quit = mock(async () => {})

beforeEach(() => {
  resolveCompatibility.mockClear()
  getClients.mockClear()
  getClients.mockImplementation(async () => ({ ok: true, clients: [] }))
  quit.mockClear()
  // Only the three members this component touches; the gate never reaches for
  // anything else, and a fuller fake would just hide that.
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    backend: { getClients, resolveCompatibility },
    app: { quit },
  }
})

function snapshot(
  state: (typeof BackendState)[keyof typeof BackendState],
  compatibility: unknown,
  lastError: string | null = null,
) {
  return { state, endpoint: null, lastError, compatibility }
}

async function renderGate(state: string, compatibility: unknown, lastError: string | null = null) {
  const store = createStore()
  store.set(backendSnapshotAtom, snapshot(state as never, compatibility, lastError) as never)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Provider store={store}>
        <GatewayBootGate>
          <div data-testid="app-body">agent ui</div>
        </GatewayBootGate>
      </Provider>,
    )
  })
  return {
    host,
    store,
    cleanup: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

describe('GatewayBootGate — version mismatch', () => {
  it('blocks the app body and never auto-restarts', async () => {
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    expect(host.querySelector('[data-testid="app-body"]')).toBeNull()
    expect(host.querySelector('[data-testid="boot-gate-resolve-compatibility"]')).not.toBeNull()
    // 这一条是本文件的核心：渲染阻塞界面**不得**顺手把 daemon 重启了。
    expect(resolveCompatibility).not.toHaveBeenCalled()

    await cleanup()
  })

  it('shows both versions so the user can see what is stale', async () => {
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    const text = host.textContent ?? ''
    expect(text).toContain('0.2.0')
    expect(text).toContain('0.1.0')

    await cleanup()
  })

  it('restarts only when the user clicks', async () => {
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    await act(async () => {
      host
        .querySelector<HTMLElement>('[data-testid="boot-gate-resolve-compatibility"]')
        ?.click()
    })

    expect(resolveCompatibility).toHaveBeenCalledTimes(1)
    await cleanup()
  })

  it('opens a gateway report with the visible version mismatch details', async () => {
    const { host, store, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="boot-gate-report-issue"]')?.click()
    })

    const request = store.get(issueReportRequestAtom)
    expect(request?.source).toBe('gateway')
    expect(request?.error).toContain('0.2.0')
    expect(request?.error).toContain('0.1.0')
    expect(resolveCompatibility).not.toHaveBeenCalled()

    await cleanup()
  })

  it('uses distinct copy when the daemon reported no version at all', async () => {
    const mismatch = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })
    const mismatchText = mismatch.host.textContent ?? ''
    await mismatch.cleanup()

    const { host, store, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Unknown,
      expected: '0.2.0',
    })
    const text = host.textContent ?? ''

    // 对照两份真实渲染结果，而不是断言「不包含某个 fixture 里根本没有的版本号」——
    // 后者恒真，连版本对照表渲染出来都发现不了。
    expect(text).not.toBe(mismatchText)
    // 没有 actual 版本时不渲染版本对照表：一行「正在运行: —」只是噪音。
    expect(text).not.toContain('0.2.0')
    expect(host.querySelector('[data-testid="boot-gate-resolve-compatibility"]')).not.toBeNull()

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="boot-gate-report-issue"]')?.click()
    })
    const request = store.get(issueReportRequestAtom)
    expect(request?.source).toBe('gateway')
    expect(request?.error).not.toContain('0.2.0')

    await cleanup()
  })

  it('names the number of clients a restart would disconnect', async () => {
    // 这条钉住的是主进程侧的守卫：fetchGatewayClients 曾经只在 Ready 时放行，
    // 于是这个警告 100% 落到最含糊的那句文案上，两条复数文案是死字符串。
    getClients.mockImplementation(async () => ({
      ok: true,
      clients: [
        { client_id: 'a', client_type: 'cli' },
        { client_id: 'b', client_type: 'gui' },
      ],
    }))
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    expect(getClients).toHaveBeenCalledTimes(1)
    expect(host.textContent ?? '').toContain('2')

    await cleanup()
  })

  it('offers no gateway restart when it is OUR install that is broken', async () => {
    // manifest 读不出来 = 应用自身损坏。重启网关永远修不好它，给这个按钮
    // 等于把用户推向一个必然失败的动作。
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.ManifestUnavailable,
      detail: 'file not found',
    })

    expect(host.querySelector('[data-testid="boot-gate-resolve-compatibility"]')).toBeNull()
    expect(host.querySelector('[data-testid="app-body"]')).toBeNull()
    expect(host.textContent ?? '').not.toBe('')

    await cleanup()
  })

  it('reports a broken install without exposing its manifest detail', async () => {
    const privateDetail = 'file not found at /Users/private-account/release-manifest.json'
    const { host, store, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.ManifestUnavailable,
      detail: privateDetail,
    })

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="boot-gate-report-issue"]')?.click()
    })

    const request = store.get(issueReportRequestAtom)
    expect(request?.source).toBe('gateway')
    expect(request?.error).not.toContain(privateDetail)
    expect(request?.error).not.toContain('/Users/private-account')

    await cleanup()
  })

  it('uses the already-visible backend error for an unavailable gateway report', async () => {
    const visibleError = 'Gateway start failed with HTTP 401'
    const { host, store, cleanup } = await renderGate(
      BackendState.Unavailable,
      null,
      visibleError,
    )

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="boot-gate-report-issue"]')?.click()
    })

    expect(store.get(issueReportRequestAtom)).toMatchObject({
      source: 'gateway',
      error: visibleError,
    })

    await cleanup()
  })

  it('lets a ready daemon through untouched', async () => {
    const { host, cleanup } = await renderGate(BackendState.Ready, {
      state: CompatibilityState.Compatible,
    })

    expect(host.querySelector('[data-testid="app-body"]')).not.toBeNull()
    expect(getClients).not.toHaveBeenCalled()

    await cleanup()
  })

  it('blocks business UI while an endpoint is being re-authenticated', async () => {
    const { host, cleanup } = await renderGate(BackendState.Unhealthy, null)

    expect(host.querySelector('[data-testid="app-body"]')).toBeNull()
    expect(host.querySelector('[data-testid="gateway-boot-gate"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="boot-gate-report-issue"]')).toBeNull()

    await cleanup()
  })

  it('does not gate a development build with no manifest verdict', async () => {
    // compatibility === null 表示「没评估」，不是「不匹配」。开发构建没有生成
    // manifest，闸门必须完全不生效，否则 `bun run dev` 直接不可用。
    const { host, cleanup } = await renderGate(BackendState.Ready, null)

    expect(host.querySelector('[data-testid="app-body"]')).not.toBeNull()

    await cleanup()
  })
})
