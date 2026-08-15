/**
 * Tests for the Windows Control Overlay height arithmetic.
 *
 * 锁的是一条**跨进程**的一致性:overlay 由系统按 DIP 绘制,TopBar 由渲染层按
 * CSS px 绘制,两者必须在任意缩放下高度相等。首版漏了缩放系数(直接给常量 44),
 * 表现是用户一按 ⌘/Ctrl 加减号,三个 caption 按钮就与顶栏错位 —— 而这在
 * macOS 上完全复现不出来(那边走 hiddenInset,压根没有 overlay)。
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ZOOM_LEVEL_MAX, ZOOM_LEVEL_MIN, zoomPercent } from '@app/shared/types'
import { TITLEBAR_HEIGHT, overlayHeightFor } from '../titlebar-metrics'

describe('TITLEBAR_HEIGHT', () => {
  // 此前这里锁的是「TopBar 的 className 必须字面等于 h-11」。那条不变式已经
  // 不存在了:顶栏高度改为跟随 `--titlebar-height`(Windows 下由
  // `useWindowControlsInset` 写入系统实测的 caption 高度),不再是写死的常量 ——
  // 两个真理源靠算术保持相等正是之前漂移的根源。
  //
  // 但它**防的东西**仍然需要防:两处高度悄悄脱钩,typecheck / lint 全绿,只有
  // Windows 上肉眼能看出错位。所以改为锁新的链路:TopBar 消费那个变量,且变量
  // 的兜底值(非 Windows / 全屏时生效)等于本文件的 TITLEBAR_HEIGHT。
  //
  // 读源码而不是渲染组件:TopBar 会连带拉起 atoms → `window`,bun:test 没有 DOM。
  const read = (rel: string): string => readFileSync(join(import.meta.dir, rel), 'utf-8')

  it('is the height TopBar actually consumes, via the shared CSS variable', () => {
    const topBar = read('../../renderer/components/amphi/TopBar.tsx')
    expect(topBar).toContain('h-[var(--titlebar-height)]')
    // 反向断言:别人把它改回写死的 Tailwind 高度类,这里就红。
    expect(topBar).not.toContain('className="h-11 ')
  })

  it('equals the CSS fallback used when no overlay can be measured', () => {
    // 兜底值走两条独立路径,都必须等于 TITLEBAR_HEIGHT:
    //   index.css     —— :root 的静态默认(非 Windows 永远用它)
    //   the hook      —— 全屏(overlay 收起)时回落到的常量
    const css = read('../../renderer/index.css')
    expect(css).toContain(`--titlebar-height: ${TITLEBAR_HEIGHT}px`)

    const hook = read('../../renderer/hooks/useWindowControlsInset.ts')
    expect(hook).toContain(`const FALLBACK_TITLEBAR_HEIGHT = ${TITLEBAR_HEIGHT}`)
  })
})

describe('overlayHeightFor', () => {
  it('equals the bare TopBar height at 100%', () => {
    expect(overlayHeightFor(0)).toBe(TITLEBAR_HEIGHT)
  })

  it('tracks the SAME zoom base the renderer uses', () => {
    // 这条是本文件的重点:不复述 `1.2 **`,而是跟 `zoomPercent()` 对齐 ——
    // 它是设置面板显示百分比的来源,也就是用户看到的那个数。谁改了缩放基数
    // 而没同步另一处,这里就红。
    for (let level = ZOOM_LEVEL_MIN; level <= ZOOM_LEVEL_MAX; level += 0.5) {
      const expected = Math.round((TITLEBAR_HEIGHT * zoomPercent(level)) / 100)
      // 容差 2 而非 1:高度要对齐到 4 的倍数(见 overlayHeightFor 的 DIP_GRID),
      // 半档如 level=1.5 精确值 57.8 → 56,偏离 2。这是**有意**放宽 —— 栅格对齐
      // 换来的是在 125/150/175% 缩放下落在整数物理像素上,而顶栏本身跟随
      // `getTitlebarAreaRect()`,这点偏差没有可见后果。
      expect(Math.abs(overlayHeightFor(level) - expected)).toBeLessThanOrEqual(2)
    }
  })

  it('always lands on the DIP grid so common Windows scalings stay integral', () => {
    // 奇数 DIP 在 150% 下落到半个物理像素被 snap,于是系统实际画出来的 caption
    // 高度与 `getTitlebarAreaRect()` 报的对不上 —— 表现为弹窗遮罩时右上角白边
    // 比左侧顶栏高一截。原实现 7 档里 5 档是奇数(31/37/53/63/91)。
    for (let level = ZOOM_LEVEL_MIN; level <= ZOOM_LEVEL_MAX; level += 0.5) {
      const h = overlayHeightFor(level)
      expect(h % 4).toBe(0)
      for (const scale of [1.25, 1.5, 1.75]) {
        expect(Number.isInteger(h * scale)).toBe(true)
      }
    }
  })

  it('grows when zoomed in and shrinks when zoomed out', () => {
    expect(overlayHeightFor(2)).toBeGreaterThan(TITLEBAR_HEIGHT)
    expect(overlayHeightFor(-2)).toBeLessThan(TITLEBAR_HEIGHT)
  })

  it('clamps a corrupt zoom level instead of returning an absurd height', () => {
    // 手改过的 settings.json 里 zoomLevel: 40 会算出几十万 px 的 overlay,
    // 整个窗口顶部被 caption 按钮吃掉 —— clampZoomLevel 必须先兜住。
    expect(overlayHeightFor(40)).toBe(overlayHeightFor(ZOOM_LEVEL_MAX))
    expect(overlayHeightFor(-40)).toBe(overlayHeightFor(ZOOM_LEVEL_MIN))
    expect(overlayHeightFor(Number.NaN)).toBe(TITLEBAR_HEIGHT)
  })
})
