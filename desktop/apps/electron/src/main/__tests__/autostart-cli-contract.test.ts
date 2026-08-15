/**
 * `amphi server autostart` 的输出契约 —— 三个动词**不是同一种格式**。
 *
 * 回归:首版把三个动词都当 JSON 解析,而只有 `status` 走 `json.dumps`;
 * `enable` / `disable` 是 `print(f"Autostart enabled via …")`(见后端
 * `src/amphi_cli/_server.py::_autostart`)。于是每次成功的切换都被解析异常吞成
 * "失败":UI 报错、且 handler 在失败分支提前 return,连带跳过了本该做的重新
 * 发现 —— app 守着一个指向已停 daemon 的旧快照。
 *
 * 这里断言的是**格式契约本身**,而不是 mock 一遍我们自己的封装:真正会漂移的
 * 是后端 CLI 的输出,所以测试直接读后端源码里的那三条 print/dumps 分支。
 * 后端哪天把 enable 也改成 JSON,这条会红,提醒我们同步简化前端。
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 后端 CLI 的 autostart 分支源码(monorepo 根的 `src/`)。 */
function autostartSource(): string {
  const path = join(import.meta.dir, '../../../../../..', 'src/amphi_cli/_server.py')
  return readFileSync(path, 'utf-8')
}

function desktopAutostartSource(): string {
  const path = join(import.meta.dir, '..', 'python-client', 'cli.ts')
  return readFileSync(path, 'utf-8')
}

/** 截出 `_autostart` 方法体,避免匹配到文件里其它地方的 print。 */
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

    // status 分支:json.dumps。前端可以 JSON.parse。
    expect(body).toContain('json.dumps(payload')

    // enable / disable 分支:人读句子。前端**不能** JSON.parse 它们的 stdout。
    expect(body).toMatch(/print\(f"Autostart enabled via/u)
    expect(body).toMatch(/print\(f"Autostart disabled via/u)
  })

  it('keeps legacy lifecycle commands but makes the Desktop toggle configure-only', () => {
    // 安装器和显式 CLI 调用继续保留历史启停语义；设置页必须带上
    // configure-only，避免切断当前 PID、token 和 WebSocket。
    const body = autostartBody(autostartSource())
    expect(body).toContain('enable_autostart(')
    expect(body).toContain('disable_autostart(')
    expect(body).toContain('configure_autostart(')
    expect(body).toContain('args.configure_only')
    expect(desktopAutostartSource()).toContain("verb, '--configure-only'")
  })
})
