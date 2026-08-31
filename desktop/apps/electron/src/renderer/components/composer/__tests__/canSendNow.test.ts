/**
 * 发送闸门 `canSendNow` —— 固化"输入可用 ≠ 可以发送"这条不变式。
 *
 * 背景:执行中的输入框刻意保持可用(用户可以先把下一条打好),但后端是
 * serial-chat,上一轮没跑完再 chat 会被 cmd_error 拒。所以解禁输入的同时,
 * 发送这一侧必须继续拦 —— 这里就是拦的地方。
 */
import { describe, expect, it } from 'bun:test'
import { canSendNow } from '../canSendNow'

const SESSION = 's-1'

describe('canSendNow', () => {
  it('只允许已有会话的空闲状态发送', () => {
    expect(canSendNow(SESSION, false, false)).toBe(true)
    // 回归:把 streaming 从 ChatInputZone 的 disabled 里摘掉后,这条是唯一
    // 阻止消息发给 serial-chat daemon 的守卫。删了它 = 用户发出去被拒。
    expect(canSendNow(SESSION, false, true)).toBe(false)
    expect(canSendNow(SESSION, true, false)).toBe(false)
    expect(canSendNow(null, false, false)).toBe(false)
    expect(canSendNow(null, true, true)).toBe(false)
    expect(canSendNow(SESSION, true, true)).toBe(false)
    expect(canSendNow(null, false, true)).toBe(false)
  })
})
