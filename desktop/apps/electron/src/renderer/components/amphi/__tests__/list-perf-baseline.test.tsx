/**
 * Render-side perf baseline for the long lists — the counterpart to the
 * backend baseline in `tests/perf/test_list_baseline.py`.
 *
 * What this measures and why: the backend baseline showed DB + serialization
 * stays under 50ms at every realistic scale, so the suspected bottleneck is the
 * renderer mounting every row. The load-bearing number here is therefore the
 * **DOM node count**, not the timing: happy-dom is not a browser, so elapsed ms
 * is only a rough relative signal, while node count is exact and is precisely
 * what windowing must hold flat as the row total grows.
 *
 * Opt-in: `AMPHI_RUN_PERF_TESTS=1 bun test --preload ./test-setup.ts \
 *   apps/electron/src/renderer/components/amphi/__tests__/list-perf-baseline.test.tsx`
 * Skipped in the default `bun run test` so it never slows the gate.
 *
 * Measured 2026-07-30 (M-series mac, happy-dom):
 *
 *   flat  content-only rows:   50 → 183 nodes |  300 →  1058 | 1000 →  3508  (3.5/row)
 *   rich  thinking+tool+md:    50 →1583 nodes |  300 →  9458 | 1000 → 31508  (31.5/row)
 *                                                 (705ms to mount at 1000)
 *
 * Read-out: a realistic transcript costs ~9x the nodes of the flat shape, so a
 * 1000-turn Session mounts ~31.5k DOM nodes today. Compare against the backend
 * baseline's 20ms for the same data: the renderer, not the daemon, is the
 * bottleneck — windowing must hold this number flat as the total grows.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Pipeline } = await import('../Pipeline')
const { createStore, Provider } = await import('jotai')

const RUN_PERF = process.env.AMPHI_RUN_PERF_TESTS === '1'

interface Row {
  role: 'user' | 'assistant'
  content: string
  messageId: string
}

function buildMessages(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `压力测试第 ${index} 条消息正文，模拟一段中等长度的对话内容。`,
    messageId: `m_${index}`,
  }))
}

/**
 * A realistic assistant turn: interleaved thinking + tool call + markdown text.
 * The flat `content`-only shape above under-reports node count badly, because
 * MessageContent's markdown path and MessageToolCall never expand for it — and
 * a baseline that under-reports would justify doing less work than needed.
 */
function buildRichMessages(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => {
    if (index % 2 === 0) {
      return {
        role: 'user',
        content: `第 ${index} 轮提问`,
        messageId: `m_${index}`,
        blocks: [{ type: 'text', text: `第 ${index} 轮提问，请分析这份数据。` }],
      }
    }
    return {
      role: 'ai',
      content: '',
      messageId: `m_${index}`,
      completedAt: 1_753_000_000_000 + index,
      durationMs: 1200,
      blocks: [
        { type: 'thinking', text: `先确认第 ${index} 轮的输入范围，再决定用哪个工具。` },
        {
          type: 'tool',
          toolUseId: `tu_${index}`,
          name: 'read_file',
          input: { path: `/tmp/perf/data_${index}.csv` },
          result: { output: `读取了 ${index} 行数据`, isError: false, durationMs: 42 },
        },
        {
          type: 'text',
          text: `## 第 ${index} 轮结论\n\n- 要点一：数据完整\n- 要点二：无异常\n\n`
            + `详见 \`data_${index}.csv\`，共 ${index * 10} 行。`,
        },
      ],
    }
  })
}

describe.skipIf(!RUN_PERF)('render baseline — message list', () => {
  for (const scale of [50, 300, 1000]) {
    it(`mounts ${scale} messages`, async () => {
      const store = createStore()
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)

      const started = performance.now()
      await act(async () => {
        root.render(
          <Provider store={store}>
            <Pipeline messages={buildMessages(scale) as never} />
          </Provider>,
        )
      })
      const elapsedMs = performance.now() - started
      const nodes = host.querySelectorAll('*').length

      console.log(
        `\n[render-baseline] message-list  scale=${String(scale).padStart(5)}  `
        + `${elapsedMs.toFixed(1).padStart(8)}ms  domNodes=${nodes}  `
        + `perRow=${(nodes / scale).toFixed(1)}`,
      )

      expect(nodes).toBeGreaterThan(0)
      await act(async () => root.unmount())
      host.remove()
    })
  }
})

describe.skipIf(!RUN_PERF)('render baseline — message list (realistic turns)', () => {
  for (const scale of [50, 300, 1000]) {
    it(`mounts ${scale} rich messages`, async () => {
      const store = createStore()
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)

      const started = performance.now()
      await act(async () => {
        root.render(
          <Provider store={store}>
            <Pipeline messages={buildRichMessages(scale) as never} />
          </Provider>,
        )
      })
      const elapsedMs = performance.now() - started
      const nodes = host.querySelectorAll('*').length

      console.log(
        `\n[render-baseline] rich-messages  scale=${String(scale).padStart(5)}  `
        + `${elapsedMs.toFixed(1).padStart(8)}ms  domNodes=${nodes}  `
        + `perRow=${(nodes / scale).toFixed(1)}`,
      )

      expect(nodes).toBeGreaterThan(0)
      await act(async () => root.unmount())
      host.remove()
    })
  }
})
