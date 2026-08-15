/**
 * 界面缩放的纯逻辑守卫:夹取区间与百分比换算。
 *
 * 这两个 helper 是主进程与渲染层**共用**的单一来源(菜单快捷键、设置面板、
 * 窗口创建时的恢复都走它们),所以它们的边界行为必须钉死在这里 —— 尤其是
 * `clampZoomLevel`:它是脏配置(手改 / 导入的 gui-settings.json)与"UI 被放大到
 * 没有任何控件可点、连撤销入口都点不到"之间唯一的一道闸。
 *
 * 非显式依赖:无。纯函数,不碰 electron、不碰磁盘。
 */
import { describe, it, expect } from 'bun:test'
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_MIN,
  clampZoomLevel,
  zoomPercent,
} from '../settings'

describe('clampZoomLevel', () => {
  it('keeps in-range levels untouched', () => {
    for (const level of [ZOOM_LEVEL_MIN, -0.5, 0, 1.5, ZOOM_LEVEL_MAX]) {
      expect(clampZoomLevel(level)).toBe(level)
    }
  })

  it('clamps out-of-range levels to the usable window', () => {
    expect(clampZoomLevel(40)).toBe(ZOOM_LEVEL_MAX)
    expect(clampZoomLevel(-40)).toBe(ZOOM_LEVEL_MIN)
  })

  it('falls back to 100% for non-finite input', () => {
    // 脏配置(手改 / 导入)里 zoomLevel 可能是 null → NaN。放任它进
    // setZoomLevel 会让整窗渲染异常,且用户无从恢复。
    expect(clampZoomLevel(Number.NaN)).toBe(0)
    expect(clampZoomLevel(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('zoomPercent', () => {
  it('maps level 0 to exactly 100%', () => {
    expect(zoomPercent(0)).toBe(100)
  })

  it('uses a ~110% first step, matching browser zoom feel', () => {
    // 步长取 0.5(而非整数 1)就是为了这一档:整数步一上来跳到 120%,
    // 对"字号偏小"这个诉求太粗。
    expect(zoomPercent(0.5)).toBe(110)
  })

  it('clamps before converting, so dirty input never yields absurd percentages', () => {
    expect(zoomPercent(999)).toBe(zoomPercent(ZOOM_LEVEL_MAX))
  })
})

describe('DEFAULT_SETTINGS', () => {
  it('starts at 100% and carries the current version', () => {
    expect(DEFAULT_SETTINGS.zoomLevel).toBe(0)
    expect(DEFAULT_SETTINGS.version).toBe(SETTINGS_VERSION)
    expect(DEFAULT_SETTINGS.ui.telemetryOptIn).toBe(true)
    expect(DEFAULT_SETTINGS.layout.rightPanelWidth).toBe(320)
  })

  it('no longer carries the dead font slice', () => {
    // font.family / font.size 曾被写进 --font-family / --font-size,但 CSS 读的是
    // --font-sans、且没有任何规则读 --font-size —— 死配置,已随 v2 迁移删除。
    expect('font' in DEFAULT_SETTINGS).toBe(false)
  })
})
